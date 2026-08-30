import {
  createAccount,
  issueKey,
  listAccounts,
  listKeys,
  openDb,
  revokeKey,
  updateAccount,
  usageWindow,
  getAccount,
} from "./api/store";
import { maskKey } from "./api/keys";
import type { DetailLevel } from "./api/serialize";

/**
 * Admin CLI for the public API.
 *
 * Run with `npm run api` — it talks to the same SQLite file the routes use, so
 * it must run on the machine that serves the API (or against the same
 * API_DB_PATH).
 *
 * This is deliberately a command-line tool and not an admin endpoint. An HTTP
 * route that can mint credentials is a route that has to be defended forever,
 * and there is nothing to defend if it does not exist. When the customer count
 * makes a dashboard worth building, build it against these same functions.
 *
 *   npm run api -- accounts
 *   npm run api -- new-account "Acme Builders" --quota 500 --rate 120 --detail lines
 *   npm run api -- new-key acct_xxx --env live --label "production"
 *   npm run api -- keys acct_xxx
 *   npm run api -- revoke <lookup>
 *   npm run api -- plan acct_xxx --quota 1000 --detail lines
 *   npm run api -- disable acct_xxx
 *   npm run api -- enable acct_xxx
 *   npm run api -- usage acct_xxx
 */

const args = process.argv.slice(2);
const cmd = args[0];

const flag = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const num = (name: string): number | undefined => {
  const v = flag(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) fail(`--${name} must be a non-negative number`);
  return n;
};

const detailFlag = (): DetailLevel | undefined => {
  const v = flag("detail");
  if (v === undefined) return undefined;
  if (v !== "summary" && v !== "lines") fail(`--detail must be "summary" or "lines"`);
  return v;
};

function fail(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

const usd = (n: number) => n.toLocaleString("en-US");

function main() {
  openDb();

  switch (cmd) {
    case "accounts": {
      const rows = listAccounts();
      if (rows.length === 0) {
        console.log("No accounts yet. Create one:\n  npm run api -- new-account \"Name\"");
        return;
      }
      for (const a of rows) {
        const u = usageWindow(a);
        console.log(
          `${a.id}  ${a.name}\n` +
            `    plan: ${a.maxDetail}  quota: ${u.billableUsed}/${usd(a.monthlyQuota)} this month  ` +
            `rate: ${a.ratePerMin}/min` +
            (a.disabledAt ? `  [DISABLED ${a.disabledAt}]` : ""),
        );
      }
      return;
    }

    case "new-account": {
      const name = args[1];
      if (!name || name.startsWith("--")) fail(`Usage: new-account "Customer name" [--quota N] [--rate N] [--detail summary|lines]`);
      const a = createAccount(name, {
        monthlyQuota: num("quota"),
        ratePerMin: num("rate"),
        maxDetail: detailFlag(),
      });
      console.log(`Created ${a.id}`);
      console.log(`  name:   ${a.name}`);
      console.log(`  plan:   ${a.maxDetail}`);
      console.log(`  quota:  ${usd(a.monthlyQuota)} estimates/month`);
      console.log(`  rate:   ${a.ratePerMin} requests/minute`);
      console.log(`\nNext: npm run api -- new-key ${a.id} --env live`);
      return;
    }

    case "new-key": {
      const accountId = args[1];
      if (!accountId || accountId.startsWith("--")) fail("Usage: new-key <account_id> [--env live|test] [--label text]");
      const env = (flag("env") ?? "live") as "live" | "test";
      if (env !== "live" && env !== "test") fail(`--env must be "live" or "test"`);
      let issued;
      try {
        issued = issueKey(accountId, env, flag("label") ?? "");
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
      // The only time this string exists. Said plainly, because a customer who
      // assumes they can look it up later will lose it.
      console.log(`\n  ${issued.plaintext}\n`);
      console.log("This is the only time the key is shown. It is stored as a hash;");
      console.log("nobody — including you — can read it back. Losing it means issuing a new one.");
      return;
    }

    case "keys": {
      const accountId = args[1];
      if (!accountId) fail("Usage: keys <account_id>");
      const rows = listKeys(accountId);
      if (rows.length === 0) {
        console.log("No keys for that account.");
        return;
      }
      for (const k of rows) {
        const state = k.revokedAt ? `revoked ${k.revokedAt}` : "active";
        const used = k.lastUsedAt ? `last used ${k.lastUsedAt}` : "never used";
        console.log(`${maskKey(k.env, k.lookup)}  ${k.env}  ${state}  ${used}  ${k.label}`);
      }
      return;
    }

    case "revoke": {
      const lookup = args[1];
      if (!lookup) fail("Usage: revoke <lookup>   (the 8 characters shown by `keys`)");
      console.log(
        revokeKey(lookup)
          ? `Revoked ${lookup}. It stops working on the next request.`
          : `No active key with lookup "${lookup}".`,
      );
      return;
    }

    case "plan": {
      const accountId = args[1];
      if (!accountId) fail("Usage: plan <account_id> [--quota N] [--rate N] [--detail summary|lines]");
      const a = updateAccount(accountId, {
        monthlyQuota: num("quota"),
        ratePerMin: num("rate"),
        maxDetail: detailFlag(),
      });
      if (!a) fail(`No such account: ${accountId}`);
      console.log(
        `${a.id}: plan ${a.maxDetail}, ${usd(a.monthlyQuota)} estimates/month, ${a.ratePerMin}/min`,
      );
      return;
    }

    case "disable":
    case "enable": {
      const accountId = args[1];
      if (!accountId) fail(`Usage: ${cmd} <account_id>`);
      const a = updateAccount(accountId, { disabled: cmd === "disable" });
      if (!a) fail(`No such account: ${accountId}`);
      console.log(`${a.id} is now ${a.disabledAt ? "disabled" : "enabled"}.`);
      return;
    }

    case "usage": {
      const accountId = args[1];
      if (!accountId) fail("Usage: usage <account_id>");
      const a = getAccount(accountId);
      if (!a) fail(`No such account: ${accountId}`);
      const u = usageWindow(a);
      console.log(`${a.name} (${a.id})`);
      console.log(`  period starting ${u.periodStart}`);
      console.log(`  estimates: ${u.billableUsed} of ${usd(u.quota)}`);
      console.log(`  requests in the last minute: ${u.requestsThisMinute} of ${u.ratePerMin}`);
      return;
    }

    default:
      console.log(
        `Usage:
  npm run api -- accounts
  npm run api -- new-account "Customer name" [--quota N] [--rate N] [--detail summary|lines]
  npm run api -- new-key <account_id> [--env live|test] [--label text]
  npm run api -- keys <account_id>
  npm run api -- revoke <lookup>
  npm run api -- plan <account_id> [--quota N] [--rate N] [--detail summary|lines]
  npm run api -- disable <account_id>
  npm run api -- enable <account_id>
  npm run api -- usage <account_id>

The database is ${process.env.API_DB_PATH ?? "data/api.db"} — set API_DB_PATH to point elsewhere.`,
      );
      process.exit(cmd ? 1 : 0);
  }
}

main();
