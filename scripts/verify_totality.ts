import axios from 'axios';

const STRATZ_GQL = 'https://api.stratz.com/graphql';
const STRATZ_API_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJTdWJqZWN0IjoiN2I3YTUwYzYtYWJkMy00NThiLTkwZWQtNDJjOTM2NzA3MjMzIiwiU3RlYW1JZCI6IjE2NTE5NjM2MCIsIkFQSVVzZXIiOiJ0cnVlIiwibmJmIjoxNzczMDc3NzgyLCJleHAiOjE4MDQ2MTM3ODIsImlhdCI6MTc3MzA3Nzc4MiwiaXNzIjoiaHR0cHM6Ly9hcGkuc3RyYXR6LmNvbSJ9.M5pa5A2VSlLidKCgmH8JSKFoxymXrvNLY9mlRVF1t0c';

const MATCH_QUERY = `
query ($matchId: Long!) {
  match(id: $matchId) {
    id
    endDateTime
    averageImp
    gameVersionId
    regionId
    numHumanPlayers
    players {
      heroAverage {
        apm casts abilityCasts kills deaths assists networth xp cs dn neutrals heroDamage towerDamage physicalDamage magicalDamage tripleKill ultraKill rampage godLike goldPerMinute disableCount disableDuration stunCount stunDuration slowCount slowDuration healingSelf healingAllies invisibleCount
      }
      stats {
        assistEvents { time target gold xp positionX positionY }
        itemUsed { itemId count }
        allTalks { time message pausedTick }
        chatWheels { time chatWheelId pauseTick }
        actionReport { moveToPosition moveToTarget attackPosition attackTarget castPosition castTarget castNoTarget heldPosition glyphCast scanUsed pingUsed }
        locationReport { positionX positionY }
        inventoryReport {
          item0 { itemId charges secondaryCharges }
          item1 { itemId charges secondaryCharges }
          item2 { itemId charges secondaryCharges }
          item3 { itemId charges secondaryCharges }
          item4 { itemId charges secondaryCharges }
          item5 { itemId charges secondaryCharges }
          backPack0 { itemId charges secondaryCharges }
          backPack1 { itemId charges secondaryCharges }
          backPack2 { itemId charges secondaryCharges }
          neutral0 { itemId charges secondaryCharges }
        }
      }
    }
  }
}
`;

async function verify() {
  const matchId = 8728347620; // Use a known match ID
  console.log(`Verifying absolute totality for match ${matchId}...`);

  const response = await axios.post(
    STRATZ_GQL,
    {
      query: MATCH_QUERY,
      variables: { matchId }
    },
    {
      headers: {
        Authorization: `Bearer ${STRATZ_API_KEY}`,
        'Content-Type': 'application/json',
        'User-Agent': 'STRATZ_API',
      }
    }
  );

  if (response.data?.errors) {
    console.error("Verification failed with GQL errors:", JSON.stringify(response.data.errors, null, 2));
    process.exit(1);
  }

  const match = response.data?.data?.match;
  if (!match) {
    console.error("No match data returned.");
    process.exit(1);
  }

  console.log("Verification Success!");
  console.log("Match Avg IMP:", match.averageImp);
  console.log("Game Version:", match.gameVersionId);
  console.log("Num Players:", match.players.length);
  const p1 = match.players[0];
  console.log("P0 Assist Events Count:", p1.stats.assistEvents?.length || 0);
  console.log("P0 Action Report Status:", !!p1.stats.actionReport);
  console.log("P0 Location Report Count:", p1.stats.locationReport?.length || 0);
  console.log("P0 Inventory Report Count:", p1.stats.inventoryReport?.length || 0);
}

verify().catch(console.error);
