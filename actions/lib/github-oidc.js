"use strict";

async function requestOIDCToken(audience) {
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  const requestURL = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  if (!requestToken || !requestURL) {
    throw new Error("GitHub Actions OIDC environment is unavailable; set permissions.id-token to write");
  }
  const url = new URL(requestURL);
  if (audience) {
    url.searchParams.set("audience", audience);
  }
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${requestToken}`,
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub OIDC token request failed with ${response.status}`);
  }
  const body = await response.json();
  if (!body.value) {
    throw new Error("GitHub OIDC response did not include a token value");
  }
  return body.value;
}

module.exports = { requestOIDCToken };
