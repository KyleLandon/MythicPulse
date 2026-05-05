/**
 * MythicPulse — Warcraft Logs Sample Data Fetcher
 *
 * Pulls M+ event data from the WCL GraphQL API v2 for parser development.
 *
 * Usage:
 *   node fetch-wcl-sample.js
 *   node fetch-wcl-sample.js <report_code>    (fetch a specific report)
 *
 * Output: saves JSON files to ./sample-data/
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const CLIENT_ID = 'a1b597c4-827b-4d19-ba8b-6723644bcdaf';
const CLIENT_SECRET = 'VegICgNlUq6SWjaK1XTftAWGDn7eapt36Ccat3aV';

const OUTPUT_DIR = path.join(__dirname, '..', 'sample-data');

// --- HTTP helpers ---

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getToken() {
  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const body = 'grant_type=client_credentials';
  const res = await httpsRequest({
    hostname: 'www.warcraftlogs.com',
    path: '/oauth/token',
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': body.length
    }
  }, body);

  if (res.status !== 200) {
    throw new Error(`Auth failed (${res.status}): ${res.body}`);
  }
  return JSON.parse(res.body).access_token;
}

async function graphql(token, query, variables = {}) {
  const body = JSON.stringify({ query, variables });
  const res = await httpsRequest({
    hostname: 'www.warcraftlogs.com',
    path: '/api/v2/client',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    }
  }, body);

  const parsed = JSON.parse(res.body);
  if (parsed.errors) {
    console.error('GraphQL errors:', JSON.stringify(parsed.errors, null, 2));
  }
  return parsed;
}

// --- Data fetching ---

async function listMythicPlusZones(token) {
  const result = await graphql(token, `{
    worldData {
      zones {
        id
        name
        expansion { name id }
      }
    }
  }`);

  const zones = result.data?.worldData?.zones || [];
  // M+ dungeon zones typically have specific IDs — let's show all to find current season
  return zones;
}

async function getReportFights(token, reportCode) {
  const result = await graphql(token, `{
    reportData {
      report(code: "${reportCode}") {
        code
        title
        startTime
        endTime
        zone { id name }
        owner { name }
        fights {
          id
          name
          startTime
          endTime
          kill
          difficulty
          encounterID
          keystoneLevel
          keystoneAffixes
          keystoneTime
          friendlyPlayers
          gameZone { id name }
        }
        masterData {
          actors(type: "Player") {
            id
            name
            type
            subType
            server
          }
        }
      }
    }
  }`);

  return result.data?.reportData?.report;
}

async function getEvents(token, reportCode, fightID, dataType, startTime, endTime) {
  let allEvents = [];
  let nextPageTimestamp = null;
  let page = 0;

  do {
    page++;
    const startParam = nextPageTimestamp || startTime;
    const result = await graphql(token, `{
      reportData {
        report(code: "${reportCode}") {
          events(
            fightIDs: [${fightID}]
            dataType: ${dataType}
            startTime: ${startParam}
            endTime: ${endTime}
            limit: 10000
          ) {
            data
            nextPageTimestamp
          }
        }
      }
    }`);

    const events = result.data?.reportData?.report?.events;
    if (!events) break;

    allEvents = allEvents.concat(events.data || []);
    nextPageTimestamp = events.nextPageTimestamp;

    if (page > 1) {
      process.stdout.write(`.`);
    }
  } while (nextPageTimestamp);

  return allEvents;
}

// --- Main ---

async function main() {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  console.log('=== MythicPulse — WCL Sample Data Fetcher ===\n');
  console.log('Authenticating with Warcraft Logs...');
  const token = await getToken();
  console.log('Authenticated!\n');

  // If a report code was passed as an argument, use that
  const reportCode = process.argv[2];

  if (!reportCode) {
    // List zones so we can find the right M+ zone IDs
    console.log('No report code provided. Listing available zones...\n');
    const zones = await listMythicPlusZones(token);

    console.log('Recent zones (look for current M+ season):');
    console.log('─'.repeat(60));
    zones.slice(-20).forEach(z => {
      console.log(`  ID: ${z.id.toString().padEnd(6)} ${z.name.padEnd(40)} ${z.expansion?.name || ''}`);
    });

    console.log('\n─'.repeat(60));
    console.log('\nTo fetch a specific report, run:');
    console.log('  node fetch-wcl-sample.js <REPORT_CODE>\n');
    console.log('You can find report codes in any WCL URL:');
    console.log('  https://www.warcraftlogs.com/reports/REPORT_CODE\n');
    console.log('Tip: Go to warcraftlogs.com, find any public M+ log,');
    console.log('and copy the code from the URL.\n');
    return;
  }

  // Fetch the report
  console.log(`Fetching report: ${reportCode}...`);
  const report = await getReportFights(token, reportCode);

  if (!report) {
    console.error('Report not found or not accessible.');
    return;
  }

  console.log(`Report: "${report.title}" by ${report.owner?.name}`);
  console.log(`Zone: ${report.zone?.name}\n`);

  // Show fights
  const fights = report.fights || [];
  const mPlusFights = fights.filter(f => f.keystoneLevel > 0);
  const bossFights = fights.filter(f => f.encounterID > 0);

  console.log(`Total fights: ${fights.length}`);
  console.log(`M+ fights (with keystone level): ${mPlusFights.length}`);
  console.log(`Boss encounters: ${bossFights.length}\n`);

  // Save report metadata
  const reportMeta = {
    code: report.code,
    title: report.title,
    owner: report.owner?.name,
    zone: report.zone,
    players: report.masterData?.actors || [],
    fights: fights.map(f => ({
      id: f.id,
      name: f.name,
      encounterID: f.encounterID,
      keystoneLevel: f.keystoneLevel,
      keystoneAffixes: f.keystoneAffixes,
      keystoneTime: f.keystoneTime,
      kill: f.kill,
      duration: f.endTime - f.startTime,
      startTime: f.startTime,
      endTime: f.endTime,
      gameZone: f.gameZone,
      friendlyPlayers: f.friendlyPlayers
    }))
  };

  fs.writeFileSync(
    path.join(OUTPUT_DIR, `report_${reportCode}_meta.json`),
    JSON.stringify(reportMeta, null, 2)
  );
  console.log(`Saved: report_${reportCode}_meta.json`);

  // Pick the first timed M+ fight (full dungeon run)
  const targetFight = mPlusFights.find(f => f.kill === true) || mPlusFights[0] || fights[0];

  if (!targetFight) {
    console.log('No fights found in this report.');
    return;
  }

  console.log(`\nPulling full event data for: "${targetFight.name}" (fight ${targetFight.id})`);
  if (targetFight.keystoneLevel) {
    console.log(`  Keystone: +${targetFight.keystoneLevel}`);
  }
  if (targetFight.keystoneTime) {
    console.log(`  Timer: ${(targetFight.keystoneTime / 1000 / 60).toFixed(1)} min`);
  }
  console.log(`  Duration: ${((targetFight.endTime - targetFight.startTime) / 1000 / 60).toFixed(1)} min`);
  console.log(`  Timed: ${targetFight.kill ? 'Yes' : 'No'}\n`);

  // Pull all event types we care about
  // Note: full M+ runs can have A LOT of events. We paginate automatically.
  const eventTypes = [
    'DamageDone',
    'DamageTaken',
    'Healing',
    'Casts',
    'Deaths',
    'Buffs',
    'Debuffs',
    'Interrupts',
    'Dispels'
  ];

  const allEventData = {};
  let totalEvents = 0;

  for (const dataType of eventTypes) {
    process.stdout.write(`  Fetching ${dataType}...`);
    try {
      const events = await getEvents(
        token, reportCode, targetFight.id, dataType,
        targetFight.startTime, targetFight.endTime
      );
      allEventData[dataType] = events;
      totalEvents += events.length;
      console.log(` ${events.length} events`);
    } catch (err) {
      console.log(` error: ${err.message}`);
      allEventData[dataType] = [];
    }

    // Small delay between event type queries to respect rate limits
    await new Promise(r => setTimeout(r, 500));
  }

  // Save fight events
  const fightData = {
    fight: {
      id: targetFight.id,
      name: targetFight.name,
      encounterID: targetFight.encounterID,
      keystoneLevel: targetFight.keystoneLevel,
      keystoneAffixes: targetFight.keystoneAffixes,
      keystoneTime: targetFight.keystoneTime,
      kill: targetFight.kill,
      startTime: targetFight.startTime,
      endTime: targetFight.endTime,
      duration: targetFight.endTime - targetFight.startTime,
      gameZone: targetFight.gameZone
    },
    players: (report.masterData?.actors || []).filter(p =>
      targetFight.friendlyPlayers?.includes(p.id)
    ),
    allPlayers: report.masterData?.actors || [],
    events: allEventData
  };

  const fightFile = `report_${reportCode}_fight${targetFight.id}_events.json`;
  fs.writeFileSync(
    path.join(OUTPUT_DIR, fightFile),
    JSON.stringify(fightData, null, 2)
  );

  console.log(`\nSaved: ${fightFile}`);

  // Summary
  console.log('\n=== Summary ===');
  console.log(`Events pulled for "${targetFight.name}" +${targetFight.keystoneLevel}:`);
  Object.entries(allEventData).forEach(([type, events]) => {
    console.log(`  ${type.padEnd(15)} ${events.length}`);
  });
  console.log(`  ${'TOTAL'.padEnd(15)} ${totalEvents}`);
  console.log(`\nFiles saved to: ${OUTPUT_DIR}`);
  console.log('\nDrop this folder back and we\'ll start building the parser!');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
