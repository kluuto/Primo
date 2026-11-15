# Primo

Run the streets fewer people run. Primo is a Krillion-style running game on **Monad testnet**: draw your own route, run it, and a verifier scores how rare your streets are. Verified runs are paid in MON instantly by a Solidity pool contract. Prizes are sponsor-funded (no token sale). Pilot city: San Francisco.

## What it does
- **Run tab:** draw your own route on the map, run it (simulated or live GPS), get a rarity score and an instant MON payout.
- **Leaderboard:** City, Neighborhood grid, and Friends, so slower runners can still compete on their own circle.
- **Events and social:** upcoming races and a feed of where people are running.
- **Brand challenges:** sponsors race runners on different routes of equal difficulty.
- **Wallet circle:** earnings, miles, best rarity, badges, recent payouts.
- **Anti-cheat:** a fake driven run is rejected (pace, vehicle-speed segments, track continuity).

## How it works
1. The app builds a timed GPX track for the run.
2. The Node verifier (`verify.js`) checks distance (1 to 8 mi), pace (5 to 18 min/mi), no segment faster than 8 m/s, and a continuous track. Replay protection uses the file hash.
3. Rarity = round(100 x mean(1 / (1 + count / 4))) over unique 0.001 degree map cells, where count is how often others ran that cell.
4. The verifier calls `recordRun(runner, routeHash, score)` on the **OffbeatPool** contract, which pays `participationReward` (0.25 MON), once per runner per day.

Monad: chain ID 10143, ~300 ms blocks, ~600 ms finality.

## Run it
```
npm install
# optional, for live payouts (otherwise dry run):
#   CONTRACT_ADDRESS, VERIFIER_PRIVATE_KEY, RPC_URL=https://testnet-rpc.monad.xyz, EXPLORER=https://testnet.monadscan.com
npm start
```
Open http://localhost:3000. See `.env.example`. Never commit a private key. Use a testnet-only verifier account.

## Honest limits
Unaudited demo contract. Verifier is a trusted offchain service. Rarity counts for unseen areas are seeded, and some leaderboard runners are demo data.

## Business model
Brand-funded prize pools and challenges, sponsored events, and city-by-city launches.
