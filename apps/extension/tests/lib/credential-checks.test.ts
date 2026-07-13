import { describe, expect, it } from "vitest";
import {
  credentialFieldError,
  credentialFieldWarning,
  parseHttpUrl,
  stripEndpointSuffixes,
  trimValues,
} from "@/lib/credential-checks";
import type { CredentialField } from "@/providers/types";

const textField: CredentialField = {
  key: "region",
  labelKey: "providers.polly.region",
  placeholder: "us-east-1",
  type: "text",
  hintPattern: /^[a-z0-9-]+$/,
  hintKey: "settings.hint_region",
};

const passwordField: CredentialField = {
  key: "apiKey",
  labelKey: "providers.openai.apiKey",
  placeholder: "sk-...",
  type: "password",
};

const urlField: CredentialField = {
  key: "baseUrl",
  labelKey: "providers.custom.baseUrl",
  placeholder: "http://localhost:4000/v1",
  type: "text",
  format: "url",
  stripSuffixes: ["/audio/speech", "/audio/voices"],
};

describe("trimValues", () => {
  it("strips paste artifacts from every value", () => {
    expect(trimValues({ a: " key\n", b: "\tok " })).toEqual({ a: "key", b: "ok" });
  });
});

describe("parseHttpUrl", () => {
  it("accepts absolute http(s) URLs", () => {
    expect(parseHttpUrl("http://localhost:4000/v1")?.hostname).toBe("localhost");
    expect(parseHttpUrl("https://api.example.com/v1")?.protocol).toBe("https:");
  });

  it('rejects the scheme-less "localhost:4000/v1" paste (protocol "localhost:")', () => {
    expect(parseHttpUrl("localhost:4000/v1")).toBeNull();
  });

  it("rejects unparseable and non-http values", () => {
    expect(parseHttpUrl("myserver/v1")).toBeNull();
    expect(parseHttpUrl("ftp://host/v1")).toBeNull();
    expect(parseHttpUrl("")).toBeNull();
  });
});

describe("credentialFieldError", () => {
  it("flags empty required fields but not empty optional ones", () => {
    expect(credentialFieldError(textField, "")).toBe("required");
    expect(credentialFieldError({ ...passwordField, optional: true }, "")).toBeUndefined();
  });

  it("flags invisible characters only in password fields", () => {
    expect(credentialFieldError(passwordField, "sk-a\u200Bbc")).toBe("invisible");
    expect(credentialFieldError(passwordField, "sk-a\uFEFFbc")).toBe("invisible");
    expect(credentialFieldError(textField, "us\u200B-east-1")).toBeUndefined();
    expect(credentialFieldError(passwordField, "sk-abc")).toBeUndefined();
  });

  it("flags url fields that could never be fetched", () => {
    expect(credentialFieldError(urlField, "localhost:4000/v1")).toBe("url");
    expect(credentialFieldError(urlField, "http://localhost:4000/v1")).toBeUndefined();
  });
});

describe("stripEndpointSuffixes", () => {
  it("removes pasted endpoint paths and trailing slashes", () => {
    expect(stripEndpointSuffixes(urlField, "http://host:4000/v1/audio/speech")).toBe(
      "http://host:4000/v1",
    );
    expect(stripEndpointSuffixes(urlField, "http://host:4000/v1/audio/voices/")).toBe(
      "http://host:4000/v1",
    );
    // A query can't hide the suffix: matching happens on the pathname.
    expect(stripEndpointSuffixes(urlField, "https://host/v1/audio/speech?token=x")).toBe(
      "https://host/v1?token=x",
    );
  });

  it("leaves clean and unparseable values alone", () => {
    expect(stripEndpointSuffixes(urlField, "http://host:4000/v1")).toBe("http://host:4000/v1");
    expect(stripEndpointSuffixes(urlField, "not a url")).toBe("not a url");
    expect(stripEndpointSuffixes(textField, "us-east-1")).toBe("us-east-1");
  });
});

describe("credentialFieldWarning", () => {
  const schema = [urlField, { ...passwordField, optional: true }];

  it("returns the schema hint when the pattern misses", () => {
    expect(credentialFieldWarning(textField, "US East (N. Virginia)", [textField], {})).toEqual({
      kind: "hint",
      hintKey: "settings.hint_region",
    });
    expect(credentialFieldWarning(textField, "us-east-1", [textField], {})).toBeUndefined();
    expect(credentialFieldWarning(textField, "", [textField], {})).toBeUndefined();
  });

  it("warns about URL parts that get discarded", () => {
    expect(credentialFieldWarning(urlField, "http://host/v1?api_key=x", schema, {})).toEqual({
      kind: "url_parts_ignored",
    });
    expect(credentialFieldWarning(urlField, "http://user:pw@host/v1", schema, {})).toEqual({
      kind: "url_parts_ignored",
    });
  });

  it("warns when a key would travel over plain http beyond loopback", () => {
    const values = { apiKey: "secret" };
    expect(credentialFieldWarning(urlField, "http://api.example.com/v1", schema, values)).toEqual({
      kind: "plain_http_key",
    });
    // LAN/private hosts still cross a network unencrypted, so they warn too.
    for (const host of ["10.0.0.5", "192.168.1.2", "myserver.local"]) {
      expect(credentialFieldWarning(urlField, `http://${host}:4000/v1`, schema, values)).toEqual({
        kind: "plain_http_key",
      });
    }
    // No key configured: nothing at risk.
    expect(
      credentialFieldWarning(urlField, "http://api.example.com/v1", schema, {}),
    ).toBeUndefined();
    // Loopback never leaves the machine.
    for (const host of ["localhost", "127.0.0.1", "[::1]", "dev.localhost"]) {
      expect(
        credentialFieldWarning(urlField, `http://${host}:4000/v1`, schema, values),
      ).toBeUndefined();
    }
    // https is always fine.
    expect(
      credentialFieldWarning(urlField, "https://api.example.com/v1", schema, values),
    ).toBeUndefined();
  });

  it("hints when the URL has no path (most servers mount /v1)", () => {
    expect(credentialFieldWarning(urlField, "http://localhost:4000", schema, {})).toEqual({
      kind: "missing_path",
    });
    expect(credentialFieldWarning(urlField, "http://localhost:4000/", schema, {})).toEqual({
      kind: "missing_path",
    });
    expect(
      credentialFieldWarning(urlField, "http://localhost:4000/v1", schema, {}),
    ).toBeUndefined();
  });
});
