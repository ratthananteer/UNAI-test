const { getAccessToken, refreshAccessToken } = require("./unaiAuth");

async function fetchFromApi(url, errorMessage, retryAfterUnauthorized = true) {
  if (!url) {
    throw new Error(`${errorMessage}: API URL is not configured`);
  }

  const accessToken = await getAccessToken();
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if ((response.status === 401 || response.status === 403) && retryAfterUnauthorized) {
    console.warn(`[UNAI AUTH] ${errorMessage} returned ${response.status}. Generating a new access token...`);
    await refreshAccessToken();
    return fetchFromApi(url, errorMessage, false);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const error = new Error(`${errorMessage}: HTTP ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return response.json();
}

async function generateSocketTopic(floorID) {
  const url = "https://rtls.lailab.online/gen_encrypt_topic";
  const body = new URLSearchParams({ floorID: String(floorID) });

  let response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (response.status === 401 || response.status === 403) {
    console.warn(`[UNAI AUTH] /gen_encrypt_topic returned ${response.status}. Generating a new access token...`);
    await refreshAccessToken();

    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await getAccessToken()}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ floorID: String(floorID) }),
    });
  }

  const rawBody = await response.text();
  let data;
  try {
    data = JSON.parse(rawBody);
  } catch {
    data = { raw: rawBody };
  }

  if (!response.ok) {
    const error = new Error(`Failed to generate socket topic: HTTP ${response.status}`);
    error.status = response.status;
    error.body = data;
    throw error;
  }

  if (!data?.socket_token) {
    const error = new Error("Socket topic response is missing socket_token");
    error.status = 502;
    error.body = data;
    throw error;
  }

  return {
    socket_token: data.socket_token,
    ...(data.encrypt_topic ? { encrypt_topic: data.encrypt_topic } : {}),
  };
}

module.exports = { fetchFromApi, generateSocketTopic };
