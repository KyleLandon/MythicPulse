/**
 * MythicPulse — WCL Data Import Script
 *
 * Reads the JSON files from sample-data/ and imports them into Supabase.
 *
 * Usage:
 *   set SUPABASE_URL=https://qwrrswlscrttteimnvgo.supabase.co
 *   set SUPABASE_SERVICE_KEY=your-service-role-key
 *   node scripts/import-wcl-data.js
 */

const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================
// Role detection heuristics
// ============================================

const TANK_CLASSES = ['Warrior', 'Paladin', 'DeathKnight', 'DemonHunter', 'Monk', 'Druid'];
const HEALER_CLASSES = ['Priest', 'Paladin', 'Shaman', 'Druid', 'Monk', 'Evoker'];

const TANK_SPEC_NAMES = {
  Warrior: 'Protection', Paladin: 'Protection', DeathKnight: 'Blood',
  DemonHunter: 'Vengeance', Monk: 'Brewmaster', Druid: 'Guardian',
};

const HEALER_SPEC_NAMES = {
  Priest: 'Discipline', Paladin: 'Holy', Shaman: 'Restoration',
  Druid: 'Restoration', Monk: 'Mistweaver', Evoker: 'Preservation',
};

function inferRole(player, healingBySource, damageTakenByTarget, damageDoneBySource) {
  const cls = player.subType;
  const healing = healingBySource.get(player.id) || 0;
  const damageTaken = damageTakenByTarget.get(player.id) || 0;

  const totalHealing = [...healingBySource.values()].reduce((a, b) => a + b, 0);
  const totalDamageTaken = [...damageTakenByTarget.values()].reduce((a, b) => a + b, 0);

  const healingShare = totalHealing > 0 ? healing / totalHealing : 0;
  const damageTakenShare = totalDamageTaken > 0 ? damageTaken / totalDamageTaken : 0;

  // Tank check FIRST — tanks often self-heal a lot (Brewmaster, Blood DK),
  // which can falsely trigger the healer check. A player who takes >40% of
  // group damage is the tank, period.
  if (TANK_CLASSES.includes(cls) && damageTakenShare > 0.35) {
    return { role: 'tank', spec: `${TANK_SPEC_NAMES[cls] || 'Unknown'} ${cls}` };
  }

  // Healer: does >35% of group healing AND is a healer-capable class
  // AND doesn't take tank-level damage
  if (HEALER_CLASSES.includes(cls) && healingShare > 0.35 && damageTakenShare < 0.30) {
    return { role: 'healer', spec: `${HEALER_SPEC_NAMES[cls] || 'Unknown'} ${cls}` };
  }

  return { role: 'dps', spec: cls };
}

// ============================================
// Helpers
// ============================================

function aggregateByField(events, field) {
  const map = new Map();
  for (const e of events) {
    const key = e[field];
    if (key === undefined || key === null || key < 0) continue;
    map.set(key, (map.get(key) || 0) + (e.amount || 0));
  }
  return map;
}

function computePartyHash(players) {
  const sorted = players.map(p => `${p.name}-${p.server}`).sort().join('|');
  return crypto.createHash('md5').update(sorted).digest('hex');
}

// ============================================
// Import
// ============================================

async function importFight(supabase, fightDataPath, reportMeta) {
  console.log(`\nReading ${path.basename(fightDataPath)}...`);
  const fightData = JSON.parse(fs.readFileSync(fightDataPath, 'utf-8'));
  const { fight, players, events } = fightData;

  console.log(`Fight: ${fight.name} +${fight.keystoneLevel} (${fight.kill ? 'Timed' : 'Depleted'})`);
  console.log(`Duration: ${(fight.duration / 1000 / 60).toFixed(1)} min`);
  console.log(`Players: ${players.map(p => `${p.name} (${p.subType})`).join(', ')}`);

  // --- Ensure dungeon ---
  let { data: dungeon } = await supabase
    .from('dungeons')
    .select('id')
    .eq('game_zone_id', fight.gameZone.id)
    .single();

  if (!dungeon) {
    const { data, error } = await supabase
      .from('dungeons')
      .insert({
        game_zone_id: fight.gameZone.id,
        name: fight.gameZone.name,
        expansion: 'The War Within',
        season: 'tww_s1',
        timer_ms: fight.keystoneTime,
        is_active: true,
      })
      .select('id')
      .single();

    if (error) throw new Error(`Dungeon insert failed: ${error.message}`);
    dungeon = data;
    console.log(`  Created dungeon: ${fight.gameZone.name}`);
  }

  // --- Check duplicate ---
  const { data: dupeCheck } = await supabase
    .from('runs')
    .select('id')
    .eq('wcl_report_code', reportMeta.code)
    .eq('wcl_fight_id', fight.id)
    .limit(1);

  if (dupeCheck && dupeCheck.length > 0) {
    console.log('  Duplicate run — skipping.');
    return null;
  }

  // --- Compute role heuristics ---
  const healingBySource = aggregateByField(events['Healing'] || [], 'sourceID');
  const damageTakenByTarget = aggregateByField(events['DamageTaken'] || [], 'targetID');
  const damageDoneBySource = aggregateByField(events['DamageDone'] || [], 'sourceID');

  // --- Ensure characters ---
  const characterMap = new Map(); // wcl ID → character UUID
  for (const player of players) {
    let { data: existing } = await supabase
      .from('characters')
      .select('id')
      .eq('name', player.name)
      .eq('realm', player.server)
      .eq('region', 'us')
      .single();

    if (!existing) {
      const { data, error } = await supabase
        .from('characters')
        .insert({
          name: player.name,
          realm: player.server,
          class: player.subType !== 'Unknown' ? player.subType : 'Unknown',
          region: 'us',
        })
        .select('id')
        .single();

      if (error) throw new Error(`Character insert failed for ${player.name}: ${error.message}`);
      existing = data;
    }
    characterMap.set(player.id, existing.id);
  }

  // --- Insert run ---
  const { data: runData, error: runError } = await supabase
    .from('runs')
    .insert({
      dungeon_id: dungeon.id,
      keystone_level: fight.keystoneLevel,
      keystone_affixes: fight.keystoneAffixes || [],
      duration_ms: fight.duration,
      timer_ms: fight.keystoneTime,
      timed: fight.kill,
      status: 'processing',
      source: 'wcl_import',
      wcl_report_code: reportMeta.code,
      wcl_fight_id: fight.id,
      party_hash: computePartyHash(players),
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (runError) throw new Error(`Run insert failed: ${runError.message}`);
  const runId = runData.id;
  console.log(`  Run created: ${runId}`);

  // --- Insert run_players ---
  console.log('\n  Role detection:');
  for (const player of players) {
    const { role, spec } = inferRole(player, healingBySource, damageTakenByTarget, damageDoneBySource);

    const { error } = await supabase
      .from('run_players')
      .insert({
        run_id: runId,
        character_id: characterMap.get(player.id),
        role,
        spec,
        class: player.subType,
        wcl_source_id: player.id,
      });

    if (error) throw new Error(`Run player insert failed for ${player.name}: ${error.message}`);
    console.log(`    ${player.name.padEnd(15)} → ${role.padEnd(7)} (${spec})`);
  }

  // --- Insert events in batches ---
  console.log('\n  Inserting events:');
  let totalEvents = 0;
  const BATCH_SIZE = 500;

  for (const [category, categoryEvents] of Object.entries(events)) {
    if (!categoryEvents || categoryEvents.length === 0) continue;

    const rows = categoryEvents.map(e => ({
      run_id: runId,
      timestamp_ms: e.timestamp,
      event_type: e.type,
      source_id: e.sourceID !== undefined ? e.sourceID : null,
      source_instance: e.sourceInstance || null,
      target_id: e.targetID !== undefined ? e.targetID : null,
      target_instance: e.targetInstance || null,
      ability_game_id: e.abilityGameID,
      extra_ability_game_id: e.extraAbilityGameID || null,
      amount: e.amount != null ? e.amount : null,
      mitigated: e.mitigated != null ? e.mitigated : null,
      unmitigated_amount: e.unmitigatedAmount != null ? e.unmitigatedAmount : null,
      absorbed: e.absorbed != null ? e.absorbed : null,
      overheal: e.overheal != null ? e.overheal : null,
      hit_type: e.hitType != null ? e.hitType : null,
      is_aoe: e.isAoE || false,
      killer_id: e.killerID != null ? e.killerID : null,
      killing_ability_game_id: e.killingAbilityGameID != null ? e.killingAbilityGameID : null,
      buffs: e.buffs || null,
    }));

    let inserted = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const { error } = await supabase.from('events').insert(batch);
      if (error) {
        console.error(`    Error in ${category} batch ${Math.floor(i / BATCH_SIZE)}: ${error.message}`);
        // Continue with other batches
      } else {
        inserted += batch.length;
      }
    }

    totalEvents += inserted;
    console.log(`    ${category.padEnd(15)} ${inserted.toString().padStart(7)} events`);
  }

  // --- Mark run as parsed ---
  await supabase.from('runs').update({ status: 'parsed' }).eq('id', runId);

  console.log(`\n  Total: ${totalEvents} events inserted`);
  return { runId, playerCount: players.length, eventCount: totalEvents };
}

// ============================================
// Main
// ============================================

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing environment variables. Set:');
    console.error('  SUPABASE_URL=https://qwrrswlscrttteimnvgo.supabase.co');
    console.error('  SUPABASE_SERVICE_KEY=<your service role key from Supabase dashboard>');
    console.error('\nFind your service role key at:');
    console.error('  https://supabase.com/dashboard/project/qwrrswlscrttteimnvgo/settings/api');
    process.exit(1);
  }

  const supabase = createClient(supabaseUrl, supabaseKey, {
    realtime: { transport: WebSocket },
  });

  // Test connection
  const { error: testError } = await supabase.from('dungeons').select('id').limit(1);
  if (testError) {
    console.error('Failed to connect to Supabase:', testError.message);
    process.exit(1);
  }

  const sampleDir = path.join(__dirname, '..', 'sample-data');
  const files = fs.readdirSync(sampleDir);
  const metaFile = files.find(f => f.includes('_meta.json'));
  const eventFiles = files.filter(f => f.includes('_events.json'));

  if (!metaFile || eventFiles.length === 0) {
    console.error('No sample data found. Run fetch-wcl-sample.js first.');
    process.exit(1);
  }

  console.log('=== MythicPulse — WCL Data Import ===\n');

  const meta = JSON.parse(fs.readFileSync(path.join(sampleDir, metaFile), 'utf-8'));
  console.log(`Report: "${meta.title}" by ${meta.owner}`);
  console.log(`Zone: ${meta.zone?.name}`);
  console.log(`Fights to import: ${eventFiles.length}\n`);

  let totalRuns = 0;
  let totalEvents = 0;

  for (const eventFile of eventFiles) {
    try {
      const result = await importFight(
        supabase,
        path.join(sampleDir, eventFile),
        meta
      );
      if (result) {
        totalRuns++;
        totalEvents += result.eventCount;
      }
    } catch (err) {
      console.error(`\nError importing ${eventFile}:`, err.message);
    }
  }

  console.log('\n=== Import Summary ===');
  console.log(`Runs imported: ${totalRuns}`);
  console.log(`Total events:  ${totalEvents}`);
  console.log('Done!');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
