# MythicPulse — Local Setup Guide

## Prerequisites

- Node.js 20+ installed
- Git installed
- Access to the [Supabase dashboard](https://supabase.com/dashboard/project/qwrrswlscrttteimnvgo)

## 1. Clone the repo

```
git clone https://github.com/KyleLandon/MythicPulse.git
cd MythicPulse
```

## 2. Install dependencies

```
npm install
```

## 3. Set up environment variables

Create a `.env` file in the project root (or just set them in your terminal before running scripts):

```
SUPABASE_URL=https://qwrrswlscrttteimnvgo.supabase.co
SUPABASE_SERVICE_KEY=<your service role key>
WCL_CLIENT_ID=<your warcraft logs client id>
WCL_CLIENT_SECRET=<your warcraft logs client secret>
```

**Where to find these:**

- **Supabase service role key:** https://supabase.com/dashboard/project/qwrrswlscrttteimnvgo/settings/api → scroll to "service_role" under Project API keys
- **WCL client ID & secret:** https://www.warcraftlogs.com/api/clients → your registered client
- Both are also in your `Secrets/secrets.txt` file on your work PC (this file is gitignored)

## 4. Running scripts

Since we don't have dotenv installed yet, set env vars in your terminal first:

**Windows (Command Prompt):**
```
set SUPABASE_URL=https://qwrrswlscrttteimnvgo.supabase.co
set SUPABASE_SERVICE_KEY=your-key-here
set WCL_CLIENT_ID=your-client-id
set WCL_CLIENT_SECRET=your-client-secret
```

**Windows (PowerShell):**
```
$env:SUPABASE_URL="https://qwrrswlscrttteimnvgo.supabase.co"
$env:SUPABASE_SERVICE_KEY="your-key-here"
$env:WCL_CLIENT_ID="your-client-id"
$env:WCL_CLIENT_SECRET="your-client-secret"
```

Then run:

```
# Fetch sample M+ data from Warcraft Logs
node scripts/fetch-wcl-sample.js <REPORT_CODE>

# Import fetched data into Supabase
node scripts/import-wcl-data.js
```

## Project structure

```
MythicPulse/
├── PRD-MythicPulse.md          # Product requirements document
├── SETUP.md                    # This file
├── package.json
├── .gitignore
├── .env.example                # Template for env vars
├── Secrets/                    # Local-only, gitignored
├── scripts/
│   ├── fetch-wcl-sample.js     # Pull M+ event data from WCL API
│   └── import-wcl-data.js      # Parse & import into Supabase
├── src/
│   └── parser/
│       └── wcl-import.ts       # TypeScript version of the parser
└── sample-data/                # Fetched JSON files, gitignored
```

## Database

The Supabase project (MythicPulse) is already set up with the full schema. No migrations needed — it's live and has sample data from a +15 Algeth'ar Academy run.

Dashboard: https://supabase.com/dashboard/project/qwrrswlscrttteimnvgo
