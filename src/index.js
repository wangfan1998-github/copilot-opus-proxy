import { formatQuota, loadAccounts, loadSavedAccounts, loginNewAccount, refreshAccount } from "./auth.js";
import { startProxy } from "./proxy.js";

async function run() {
  const command = process.argv[2] || "serve";

  if (command === "login") {
    await loginNewAccount();
    return;
  }

  if (command === "list") {
    const savedAccounts = loadSavedAccounts();

    if (savedAccounts.length === 0) {
      console.log("No accounts saved.");
      return;
    }

    const results = await Promise.allSettled(
      savedAccounts.map((account) => refreshAccount(account.githubToken)),
    );

    for (let index = 0; index < savedAccounts.length; index += 1) {
      const result = results[index];
      if (result.status === "fulfilled" && result.value.userInfo) {
        console.log(`#${index + 1} ${formatQuota(result.value.userInfo)}`);
      } else {
        console.log(`#${index + 1} (invalid token)`);
      }
    }
    return;
  }

  if (command !== "serve") {
    console.log("Usage:");
    console.log("  node src/index.js");
    console.log("  node src/index.js login");
    console.log("  node src/index.js list");
    process.exitCode = 1;
    return;
  }

  const accounts = await loadAccounts();
  if (accounts.length === 0) {
    console.log("No accounts found. Starting first-time login...");
    accounts.push(await loginNewAccount());
  }

  console.log(`\nLoaded ${accounts.length} account(s):`);
  for (let index = 0; index < accounts.length; index += 1) {
    const userInfo = accounts[index].userInfo;
    if (userInfo) {
      console.log(`  #${index + 1} ${formatQuota(userInfo)}`);
    } else {
      console.log(`  #${index + 1} (no user info)`);
    }
  }
  console.log();

  const port = Number.parseInt(process.env.PORT || "4123", 10);
  const server = startProxy(accounts, port);

  console.log(`Copilot proxy listening on http://127.0.0.1:${port}`);
  console.log("  POST /v1/messages");
  console.log("  GET  /v1/models");
  console.log("  GET  /healthz");
  console.log(`\nExample: ANTHROPIC_BASE_URL=http://127.0.0.1:${port} your-app`);

  process.on("SIGINT", () => {
    server.close(() => process.exit(0));
  });
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
