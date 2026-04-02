import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CLIENT_ID = atob("SXYxLmI1MDdhMDhjODdlY2ZlOTg=");

const COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

export const SUPPORTED_MODELS = [
  "claude-haiku-4.5",
  "claude-opus-4.5",
  "claude-opus-4.6",
  "claude-sonnet-4",
  "claude-sonnet-4.5",
  "claude-sonnet-4.6",
];

const CREDENTIALS_DIR = join(homedir(), ".config", "copilot-opus-proxy");
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, "credentials.json");

function readJsonFile(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function loadSavedAccounts() {
  if (!existsSync(CREDENTIALS_FILE)) {
    return [];
  }

  const data = readJsonFile(CREDENTIALS_FILE);
  if (!data) {
    return [];
  }

  if (Array.isArray(data)) {
    return data;
  }

  if (typeof data.githubToken === "string") {
    return [data];
  }

  return [];
}

function saveAccounts(accounts) {
  mkdirSync(CREDENTIALS_DIR, { recursive: true });
  writeFileSync(CREDENTIALS_FILE, `${JSON.stringify(accounts, null, 2)}\n`);
}

async function startDeviceFlow() {
  const response = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": COPILOT_HEADERS["User-Agent"],
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      scope: "read:user",
    }),
  });

  if (!response.ok) {
    throw new Error(`Device code request failed: ${response.status}`);
  }

  return response.json();
}

async function pollForAccessToken(deviceCode, intervalSeconds, expiresInSeconds) {
  const deadline = Date.now() + (expiresInSeconds * 1000);
  let intervalMs = Math.max(1000, intervalSeconds * 1000);

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));

    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": COPILOT_HEADERS["User-Agent"],
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const data = await response.json();

    if (typeof data.access_token === "string") {
      return data.access_token;
    }

    if (data.error === "authorization_pending") {
      continue;
    }

    if (data.error === "slow_down") {
      intervalMs = typeof data.interval === "number" ? data.interval * 1000 : intervalMs + 5000;
      continue;
    }

    throw new Error(`Device flow failed: ${data.error ?? "unknown_error"}`);
  }

  throw new Error("Device flow timed out");
}

async function fetchCopilotToken(githubToken) {
  const response = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      Accept: "application/json",
      Authorization: `token ${githubToken}`,
      "X-GitHub-Api-Version": "2025-04-01",
      ...COPILOT_HEADERS,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Copilot token fetch failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  if (!data?.token || !data?.refresh_in) {
    throw new Error("Invalid Copilot token response");
  }

  return data;
}

async function fetchUserInfo(githubToken) {
  try {
    const [userResponse, copilotResponse] = await Promise.all([
      fetch("https://api.github.com/user", {
        headers: {
          Accept: "application/json",
          Authorization: `token ${githubToken}`,
        },
      }),
      fetch("https://api.github.com/copilot_internal/user", {
        headers: {
          Accept: "application/json",
          Authorization: `token ${githubToken}`,
          "X-GitHub-Api-Version": "2025-04-01",
          ...COPILOT_HEADERS,
        },
      }),
    ]);

    const user = userResponse.ok ? await userResponse.json() : null;
    const copilot = copilotResponse.ok ? await copilotResponse.json() : null;
    const premium = copilot?.quota_snapshots?.premium_interactions;

    return {
      username: user?.login ?? "unknown",
      plan: copilot?.copilot_plan ?? "unknown",
      quota: premium ? {
        entitlement: premium.entitlement,
        remaining: premium.remaining,
        percentRemaining: premium.percent_remaining,
        unlimited: premium.unlimited,
        overageCount: premium.overage_count,
        overagePermitted: premium.overage_permitted,
        resetDate: copilot?.quota_reset_date ?? "",
      } : null,
    };
  } catch {
    return null;
  }
}

export async function refreshAccount(githubToken) {
  const [tokenResponse, userInfo] = await Promise.all([
    fetchCopilotToken(githubToken),
    fetchUserInfo(githubToken),
  ]);

  return {
    githubToken,
    copilotToken: tokenResponse.token,
    expiresAt: Date.now() + ((tokenResponse.refresh_in + 60) * 1000),
    userInfo,
  };
}

export async function ensureValidToken(account) {
  if (Date.now() < account.expiresAt) {
    return account;
  }

  console.log("Copilot token expired, refreshing...");
  return refreshAccount(account.githubToken);
}

function getBaseUrlFromToken(token) {
  const match = token.match(/proxy-ep=([^;]+)/);
  if (!match?.[1]) {
    return "https://api.individual.githubcopilot.com";
  }

  return `https://${match[1].replace(/^proxy\./, "api.")}`;
}

export function getCopilotBaseUrl(account) {
  return getBaseUrlFromToken(account.copilotToken);
}

export function getCopilotHeaders() {
  return { ...COPILOT_HEADERS };
}

async function enableModel(copilotToken, modelId, baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/models/${modelId}/policy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${copilotToken}`,
        ...COPILOT_HEADERS,
        "OpenAI-Intent": "chat-policy",
        "X-Interaction-Type": "chat-policy",
      },
      body: JSON.stringify({ state: "enabled" }),
    });

    return response.ok;
  } catch {
    return false;
  }
}

async function enableModelsForAccount(account) {
  const baseUrl = getCopilotBaseUrl(account);
  const results = await Promise.all(
    SUPPORTED_MODELS.map(async (modelId) => ({
      modelId,
      enabled: await enableModel(account.copilotToken, modelId, baseUrl),
    })),
  );

  for (const result of results) {
    console.log(`  ${result.modelId}: ${result.enabled ? "enabled" : "skipped"}`);
  }
}

function loadGitHubTokenFromSystem() {
  const envToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (envToken) {
    return envToken;
  }

  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const filePaths = [
    join(configDir, "github-copilot", "hosts.json"),
    join(configDir, "github-copilot", "apps.json"),
  ];

  for (const filePath of filePaths) {
    if (!existsSync(filePath)) {
      continue;
    }

    const data = readJsonFile(filePath);
    if (!data || typeof data !== "object") {
      continue;
    }

    for (const [key, value] of Object.entries(data)) {
      if (key.includes("github.com") && typeof value?.oauth_token === "string") {
        return value.oauth_token;
      }
    }
  }

  return null;
}

export async function loginNewAccount() {
  const device = await startDeviceFlow();

  console.log(`\nOpen: ${device.verification_uri}`);
  console.log(`Enter code: ${device.user_code}\n`);

  const githubToken = await pollForAccessToken(
    device.device_code,
    device.interval,
    device.expires_in,
  );

  console.log("GitHub login successful, requesting Copilot token...");
  const account = await refreshAccount(githubToken);

  console.log("Enabling Claude models...");
  await enableModelsForAccount(account);

  const accounts = loadSavedAccounts();
  const existingIndex = accounts.findIndex((item) => item.githubToken === githubToken);

  if (existingIndex >= 0) {
    accounts[existingIndex] = account;
  } else {
    accounts.push(account);
  }

  saveAccounts(accounts);

  console.log(`Login complete (${account.userInfo?.username ?? "unknown"}). Total accounts: ${accounts.length}`);
  return account;
}

export async function loadAccounts() {
  const accounts = loadSavedAccounts();
  const systemToken = loadGitHubTokenFromSystem();

  if (systemToken && !accounts.some((item) => item.githubToken === systemToken)) {
    accounts.push({
      githubToken: systemToken,
      copilotToken: "",
      expiresAt: 0,
      userInfo: null,
    });
    console.log("Found GitHub token from system config.");
  }

  if (accounts.length === 0) {
    return [];
  }

  const results = await Promise.allSettled(
    accounts.map(async (account, index) => {
      try {
        const refreshed = await refreshAccount(account.githubToken);
        console.log(`#${index + 1} ${refreshed.userInfo?.username ?? "unknown"} - token refreshed`);
        return refreshed;
      } catch (error) {
        console.log(`#${index + 1} token invalid, removing: ${error}`);
        return null;
      }
    }),
  );

  const validAccounts = results
    .map((result) => (result.status === "fulfilled" ? result.value : null))
    .filter(Boolean);

  saveAccounts(validAccounts);
  return validAccounts;
}

export function formatQuota(userInfo) {
  const parts = [`${userInfo.username} (${userInfo.plan})`];

  if (!userInfo.quota) {
    parts.push("quota: unavailable");
    return parts.join(" | ");
  }

  if (userInfo.quota.unlimited) {
    parts.push("unlimited");
    return parts.join(" | ");
  }

  parts.push(
    `${userInfo.quota.percentRemaining.toFixed(1)}% remaining (${userInfo.quota.remaining}/${userInfo.quota.entitlement})`,
  );

  if (userInfo.quota.overageCount > 0) {
    parts.push(
      `overage: ${userInfo.quota.overageCount}${userInfo.quota.overagePermitted ? "" : " (blocked)"}`,
    );
  }

  if (userInfo.quota.resetDate) {
    parts.push(`resets: ${userInfo.quota.resetDate}`);
  }

  return parts.join(" | ");
}
