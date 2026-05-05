/**
 * MythicPulse — WCL Data Import Parser
 *
 * Takes the JSON output from fetch-wcl-sample.js and inserts it into the
 * Supabase database (runs, run_players, events, characters, dungeons).
 *
 * This is the "import" path. A separate parser will handle raw WoWCombatLog.txt
 * files from the desktop app (native path).
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ============================================
// Types
// ============================================

interface WCLPlayer {
  id: number;
  name: string;
  type: string;
  subType: string;
  server: string;
}

interface WCLFight {
  id: number;
  name: string;
  encounterID: number;
  keystoneLevel: number;
  keystoneAffixes: number[];
  keystoneTime: number | null;
  kill: boolean;
  startTime: number;
  endTime: number;
  duration: number;
  gameZone: { id: number; name: string };
}

interface WCLEvent {
  timestamp: number;
  type: string;
  sourceID: number;
  sourceInstance?: number;
  targetID: number;
  targetInstance?: number;
  abilityGameID: number;
  extraAbilityGameID?: number;
  fight: number;
  // Damage/healing fields
  amount?: number;
  mitigated?: number;
  unmitigatedAmount?: number;
  absorbed?: number;
  overheal?: number;
  hitType?: number;
  isAoE?: boolean;
  buffs?: string;
  // Death fields
  killerID?: number;
  killingAbilityGameID?: number;
  // Dispel fields
  isBuff?: boolean;
  // Healing absorb context
  attackerID?: number;
  attackerInstance?: number;
}

interface WCLFightData {
  fight: WCLFight;
  players: WCLPlayer[];
  allPlayers: WCLPlayer[];
  events: Record<string, WCLEvent[]>;
}

interface WCLReportMeta {
  code: string;
  title: string;
  owner: string;
  zone: { id: number; name: string };
  players: WCLPlayer[];
  fights: WCLFight[];
}

// ============================================
// Role detection
// ============================================

const TANK_SPECS: Record<string, string[]> = {
  Warrior: ['Protection'],
  Paladin: ['Protection'],
  DeathKnight: ['Blood'],
  DemonHunter: ['Vengeance'],
  Monk: ['Brewmaster'],
  Druid: ['Guardian'],
};

const HEALER_SPECS: Record<string, string[]> = {
  Priest: ['Holy', 'Discipline'],
  Paladin: ['Holy'],
  Shaman: ['Restoration'],
  Druid: ['Restoration'],
  Monk: ['Mistweaver'],
  Evoker: ['Preservation'],
};

/**
 * Infer role from class and event patterns.
 * WCL subType gives us the class but not the spec for M+ dungeon fights.
 * We use heuristics: if they heal a lot, they're probably a healer.
 * If they take a lot of damage, they're probably a tank.
 */
function inferRole(
  player: WCLPlayer,
  healingBySource: Map<number, number>,
  damageTakenByTarget: Map<number, number>,
  damageDoneBySource: Map<number, number>,
  playerIds: number[]
): { role: 'tank' | 'healer' | 'dps'; spec: string } {
  const className = player.subType;
  const healing = healingBySource.get(player.id) || 0;
  const damageTaken = damageTakenByTarget.get(player.id) || 0;
  const damageDone = damageDoneBySource.get(player.id) || 0;

  // Calculate ratios relative to the group
  const totalHealing = Array.from(healingBySource.values()).reduce((a, b) => a + b, 0);
  const totalDamageTaken = Array.from(damageTakenByTarget.values()).reduce((a, b) => a + b, 0);

  const healingShare = totalHealing > 0 ? healing / totalHealing : 0;
  const damageTakenShare = totalDamageTaken > 0 ? damageTaken / totalDamageTaken : 0;

  // Healer: does >40% of the group's healing and is a healer-capable class
  const canHeal = HEALER_SPECS[className] !== undefined;
  if (canHeal && healingShare > 0.4) {
    const specGuess = HEALER_SPECS[className]?.[0] || 'Unknown';
    return { role: 'healer', spec: `${specGuess} ${className}` };
  }

  // Tank: takes >40% of the group's damage and is a tank-capable class
  const canTank = TANK_SPECS[className] !== undefined;
  if (canTank && damageTakenShare > 0.4) {
    const specGuess = TANK_SPECS[className]?.[0] || 'Unknown';
    return { role: 'tank', spec: `${specGuess} ${className}` };
  }

  // Default: DPS
  return { role: 'dps', spec: className };
}

// ============================================
// Key bracket helper
// ============================================

function getKeyBracket(level: number): string {
  if (level <= 9) return '2-9';
  if (level <= 12) return '10-12';
  if (level <= 15) return '13-15';
  if (level <= 19) return '16-19';
  return '20+';
}

// ============================================
// Parser
// ============================================

export class WCLImportParser {
  private supabase: SupabaseClient;

  constructor(supabaseUrl: string, supabaseServiceKey: string) {
    this.supabase = createClient(supabaseUrl, supabaseServiceKey);
  }

  /**
   * Import a full fight's event data into the database.
   */
  async importFight(
    fightDataPath: string,
    reportMeta: WCLReportMeta
  ): Promise<{ runId: string; playerCount: number; eventCount: number }> {
    console.log(`\nReading fight data from ${path.basename(fightDataPath)}...`);
    const raw = fs.readFileSync(fightDataPath, 'utf-8');
    const fightData: WCLFightData = JSON.parse(raw);

    const { fight, players, events } = fightData;

    console.log(`Fight: ${fight.name} +${fight.keystoneLevel} (${fight.kill ? 'Timed' : 'Depleted'})`);
    console.log(`Players: ${players.map(p => p.name).join(', ')}`);

    // --- Step 1: Ensure dungeon exists ---
    const dungeonId = await this.ensureDungeon(fight);
    console.log(`Dungeon: ${fight.gameZone.name} (ID: ${dungeonId})`);

    // --- Step 2: Check for duplicate run ---
    const partyHash = this.computePartyHash(players);
    const isDuplicate = await this.checkDuplicate(
      dungeonId, fight.keystoneLevel, partyHash, fight.startTime, reportMeta.code
    );
    if (isDuplicate) {
      console.log('Duplicate run detected — skipping.');
      return { runId: '', playerCount: 0, eventCount: 0 };
    }

    // --- Step 3: Compute role heuristics ---
    const healingBySource = this.aggregateBySource(events['Healing'] || []);
    const damageTakenByTarget = this.aggregateByTarget(events['DamageTaken'] || []);
    const damageDoneBySource = this.aggregateBySource(events['DamageDone'] || []);
    const playerIds = players.map(p => p.id);

    // --- Step 4: Ensure characters exist ---
    const characterMap = new Map<number, string>(); // WCL sourceID → character UUID
    for (const player of players) {
      const charId = await this.ensureCharacter(player);
      characterMap.set(player.id, charId);
    }

    // --- Step 5: Insert run ---
    const startedAt = new Date(reportMeta.fights.find(f => f.id === fight.id)?.startTime || 0);
    // WCL timestamps are relative to report start, convert to absolute
    const reportStartMs = new Date(reportMeta.code).getTime() || Date.now();

    const { data: runData, error: runError } = await this.supabase
      .from('runs')
      .insert({
        dungeon_id: dungeonId,
        keystone_level: fight.keystoneLevel,
        keystone_affixes: fight.keystoneAffixes || [],
        duration_ms: fight.duration,
        timer_ms: fight.keystoneTime,
        timed: fight.kill,
        status: 'processing',
        source: 'wcl_import',
        wcl_report_code: reportMeta.code,
        wcl_fight_id: fight.id,
        party_hash: partyHash,
        started_at: new Date().toISOString(), // approximate — WCL doesn't give absolute timestamps easily
      })
      .select('id')
      .single();

    if (runError) throw new Error(`Failed to insert run: ${runError.message}`);
    const runId = runData.id;
    console.log(`Run created: ${runId}`);

    // --- Step 6: Insert run_players ---
    const runPlayerMap = new Map<number, string>(); // WCL sourceID → run_player UUID
    for (const player of players) {
      const { role, spec } = inferRole(
        player, healingBySource, damageTakenByTarget, damageDoneBySource, playerIds
      );

      const { data: rpData, error: rpError } = await this.supabase
        .from('run_players')
        .insert({
          run_id: runId,
          character_id: characterMap.get(player.id),
          role,
          spec,
          class: player.subType,
          wcl_source_id: player.id,
        })
        .select('id')
        .single();

      if (rpError) throw new Error(`Failed to insert run_player: ${rpError.message}`);
      runPlayerMap.set(player.id, rpData.id);
      console.log(`  ${player.name} → ${role} (${spec})`);
    }

    // --- Step 7: Insert events in batches ---
    let totalEvents = 0;
    const BATCH_SIZE = 1000;

    for (const [eventCategory, categoryEvents] of Object.entries(events)) {
      if (!categoryEvents || categoryEvents.length === 0) continue;

      const rows = categoryEvents.map((e: WCLEvent) => ({
        run_id: runId,
        timestamp_ms: e.timestamp,
        event_type: e.type,
        source_id: e.sourceID,
        source_instance: e.sourceInstance || null,
        target_id: e.targetID,
        target_instance: e.targetInstance || null,
        ability_game_id: e.abilityGameID,
        extra_ability_game_id: e.extraAbilityGameID || null,
        amount: e.amount || null,
        mitigated: e.mitigated || null,
        unmitigated_amount: e.unmitigatedAmount || null,
        absorbed: e.absorbed || null,
        overheal: e.overheal || null,
        hit_type: e.hitType || null,
        is_aoe: e.isAoE || false,
        killer_id: e.killerID || null,
        killing_ability_game_id: e.killingAbilityGameID || null,
        buffs: e.buffs || null,
      }));

      // Insert in batches
      for (let i = 0; i < rows.length; i += BATCH_SIZE) {
        const batch = rows.slice(i, i + BATCH_SIZE);
        const { error } = await this.supabase.from('events').insert(batch);
        if (error) {
          console.error(`Error inserting ${eventCategory} batch ${i}: ${error.message}`);
        }
      }

      totalEvents += rows.length;
      console.log(`  ${eventCategory}: ${rows.length} events inserted`);
    }

    // --- Step 8: Mark run as parsed ---
    await this.supabase
      .from('runs')
      .update({ status: 'parsed' })
      .eq('id', runId);

    console.log(`\nImport complete: ${totalEvents} events, ${players.length} players`);
    return { runId, playerCount: players.length, eventCount: totalEvents };
  }

  // --- Helpers ---

  private async ensureDungeon(fight: WCLFight): Promise<number> {
    // Check if dungeon already exists
    const { data: existing } = await this.supabase
      .from('dungeons')
      .select('id')
      .eq('game_zone_id', fight.gameZone.id)
      .single();

    if (existing) return existing.id;

    // Insert new dungeon
    const { data, error } = await this.supabase
      .from('dungeons')
      .insert({
        game_zone_id: fight.gameZone.id,
        name: fight.gameZone.name,
        expansion: 'The War Within',
        season: 'tww_s1',
        timer_ms: fight.keystoneTime, // use first seen timer as baseline
        is_active: true,
      })
      .select('id')
      .single();

    if (error) throw new Error(`Failed to insert dungeon: ${error.message}`);
    return data.id;
  }

  private async ensureCharacter(player: WCLPlayer): Promise<string> {
    // Check if character already exists
    const { data: existing } = await this.supabase
      .from('characters')
      .select('id')
      .eq('name', player.name)
      .eq('realm', player.server)
      .eq('region', 'us')
      .single();

    if (existing) return existing.id;

    // Insert new character (no player_id link yet — they haven't signed up)
    const { data, error } = await this.supabase
      .from('characters')
      .insert({
        name: player.name,
        realm: player.server,
        class: player.subType !== 'Unknown' ? player.subType : 'Unknown',
        region: 'us',
      })
      .select('id')
      .single();

    if (error) throw new Error(`Failed to insert character: ${error.message}`);
    return data.id;
  }

  private computePartyHash(players: WCLPlayer[]): string {
    const sorted = players.map(p => `${p.name}-${p.server}`).sort().join('|');
    return crypto.createHash('md5').update(sorted).digest('hex');
  }

  private async checkDuplicate(
    dungeonId: number,
    keystoneLevel: number,
    partyHash: string,
    _startTime: number,
    wclReportCode: string
  ): Promise<boolean> {
    // Check by WCL report code first (exact match)
    const { data } = await this.supabase
      .from('runs')
      .select('id')
      .eq('wcl_report_code', wclReportCode)
      .eq('wcl_fight_id', _startTime)
      .limit(1);

    return (data && data.length > 0) || false;
  }

  private aggregateBySource(events: WCLEvent[]): Map<number, number> {
    const map = new Map<number, number>();
    for (const e of events) {
      const current = map.get(e.sourceID) || 0;
      map.set(e.sourceID, current + (e.amount || 0));
    }
    return map;
  }

  private aggregateByTarget(events: WCLEvent[]): Map<number, number> {
    const map = new Map<number, number>();
    for (const e of events) {
      const current = map.get(e.targetID) || 0;
      map.set(e.targetID, current + (e.amount || 0));
    }
    return map;
  }
}

// ============================================
// CLI Runner
// ============================================

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    console.error('Missing environment variables:');
    console.error('  SUPABASE_URL=https://your-project.supabase.co');
    console.error('  SUPABASE_SERVICE_KEY=your-service-role-key');
    process.exit(1);
  }

  const sampleDir = path.join(__dirname, '..', '..', 'sample-data');

  // Find meta and event files
  const files = fs.readdirSync(sampleDir);
  const metaFile = files.find(f => f.includes('_meta.json'));
  const eventFiles = files.filter(f => f.includes('_events.json'));

  if (!metaFile) {
    console.error('No meta file found in sample-data/');
    process.exit(1);
  }
  if (eventFiles.length === 0) {
    console.error('No event files found in sample-data/');
    process.exit(1);
  }

  console.log('=== MythicPulse — WCL Import ===\n');

  const meta: WCLReportMeta = JSON.parse(
    fs.readFileSync(path.join(sampleDir, metaFile), 'utf-8')
  );
  console.log(`Report: "${meta.title}" by ${meta.owner}`);
  console.log(`Fights: ${meta.fights.length}\n`);

  const parser = new WCLImportParser(supabaseUrl, supabaseKey);

  for (const eventFile of eventFiles) {
    const result = await parser.importFight(
      path.join(sampleDir, eventFile),
      meta
    );
    if (result.runId) {
      console.log(`\n✓ Run ${result.runId}: ${result.playerCount} players, ${result.eventCount} events`);
    }
  }

  console.log('\nDone!');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
