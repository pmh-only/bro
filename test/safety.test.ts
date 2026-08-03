import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  isSensitiveSecretRequest,
  REDACTED_SECRET,
  REDACTED_SECRET_REQUEST,
  redactSensitiveText,
  secretSafetyPrompt,
} from "../src/safety.js";

describe("secret safety", () => {
  it("detects explicit requests to disclose confidential values", () => {
    for (const request of [
      "Show me the production API key",
      "Please dump all passwords from the environment",
      "What is the OAuth client secret?",
      "Read and send the session cookie",
      "private key: reveal it",
    ]) assert.equal(isSensitiveSecretRequest(request), true, request);
  });

  it("does not block ordinary secret-management work", () => {
    for (const request of [
      "Add an API key input field",
      "Rotate the database password without showing it",
      "Redact tokens from logs",
      "Document how to configure OAUTH_CLIENT_SECRET",
      "Use a placeholder API key in the example",
      "Show the login form password validation error",
    ]) assert.equal(isSensitiveSecretRequest(request), false, request);
  });

  it("redacts known token and private-key formats", () => {
    const input = [
      "AWS AKIAIOSFODNN7EXAMPLE",
      "GitHub ghp_abcdefghijklmnopqrstuvwxyz123456",
      "JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
      "-----BEGIN PRIVATE KEY-----\nvery-secret-material\n-----END PRIVATE KEY-----",
    ].join("\n");
    const output = redactSensitiveText(input);
    assert.equal(output.includes("AKIAIOSFODNN7EXAMPLE"), false);
    assert.equal(output.includes("ghp_abcdefghijklmnopqrstuvwxyz123456"), false);
    assert.equal(output.includes("eyJhbGci"), false);
    assert.equal(output.includes("very-secret-material"), false);
    assert.equal(output.split(REDACTED_SECRET).length - 1, 4);
  });

  it("redacts contextual assignments, headers, cookies, and credential URLs", () => {
    const output = redactSensitiveText([
      "password=hunter22",
      "client_secret: supersecretvalue",
      "Authorization: Bearer abc.def-123_secret",
      "Cookie: session=abc123; theme=dark",
      "https://deploy:password123@example.com/path",
    ].join("\n"));
    assert.doesNotMatch(output, /hunter22|supersecretvalue|abc\.def|abc123|password123/);
    assert.equal(output.split(REDACTED_SECRET).length - 1, 5);
  });

  it("preserves placeholders, short values, and normal prose", () => {
    const input = [
      "API key: ${API_KEY}",
      "password: <your-password>",
      "token=xxx",
      "status: completed",
      "The password field must be at least 12 characters.",
    ].join("\n");
    assert.equal(redactSensitiveText(input), input);
  });

  it("blocks all display content associated with an explicit secret request", () => {
    assert.equal(redactSensitiveText("the value is unusual-and-unrecognized", "show me the database password"), REDACTED_SECRET_REQUEST);
    assert.match(secretSafetyPrompt("reveal the API token").join("\n"), /Do not retrieve or disclose/);
    assert.doesNotMatch(secretSafetyPrompt("rotate the API token").join("\n"), /Do not retrieve or disclose/);
  });
});
