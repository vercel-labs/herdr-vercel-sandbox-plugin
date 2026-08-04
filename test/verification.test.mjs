import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyAdapterEvidence, verifyRemoteSourceFreshness } from "../src/verification.mjs";

const checks = [
  "linuxInstallation",
  "remoteAuthentication",
  "interactiveLaunch",
  "ttyBehavior",
  "credentialPersistence",
  "herdrDetection",
  "sandboxRuntime",
];

const digest = (value) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const evidenceRoot = await mkdtemp(path.join(tmpdir(), "herdr-evidence-"));
  await mkdir(path.join(evidenceRoot, "sources"));
  await mkdir(path.join(evidenceRoot, "receipts"));
  const quote = "fixture install command";
  const capture = `Official documentation\n${quote}\n`;
  await writeFile(path.join(evidenceRoot, "sources", "fixture.txt"), capture);
  const phases = [];
  for (const name of ["install", "authenticate", "modify", "export", "stop", "reconnect", "persistence"]) {
    const output = `receipts/${name}.txt`;
    const contents = `${name} passed\n`;
    await writeFile(path.join(evidenceRoot, output), contents);
    phases.push({ name, exitStatus: 0, output, outputSha256: digest(contents) });
  }
  const receiptArtifact = {
    agentVersion: "1.0.0",
    method: "interactive-lifecycle-v1",
    observedAt: "2026-08-01T12:00:00.000Z",
    command: ["node", "fixture-runner.mjs"],
    environment: { sandboxCliVersion: "56.2.0", runtime: "node24" },
    exitStatus: 0,
    phases,
    claims: checks,
  };
  const receiptText = `${JSON.stringify(receiptArtifact, null, 2)}\n`;
  await writeFile(path.join(evidenceRoot, "receipts", "fixture.json"), receiptText);
  const transcript = "raw interactive transcript\n";
  await writeFile(path.join(evidenceRoot, "receipts", "transcript.txt"), transcript);
  const behaviorReceipt = {
    agentVersion: receiptArtifact.agentVersion,
    method: receiptArtifact.method,
    observedAt: receiptArtifact.observedAt,
    command: receiptArtifact.command,
    environment: receiptArtifact.environment,
    exitStatus: receiptArtifact.exitStatus,
    transcript: "receipts/transcript.txt",
    transcriptSha256: digest(transcript),
    receipt: "receipts/fixture.json",
    receiptSha256: digest(receiptText),
  };
  const record = {
    kind: "fixture-agent",
    version: "1.0.0",
    sources: [{
      canonicalUrl: "https://example.com/fixture-agent",
      authority: "first-party",
      sourceClassification: "official-product-documentation",
      verificationMethod: "exact-text-and-sha256-v1",
      retrievedAt: "2026-08-01",
      freshness: {
        mode: "remote",
        checkedAt: "2026-08-01T12:00:00.000Z",
        checkIntervalDays: 90,
        upstreamSha256: digest(capture),
      },
      capture: "sources/fixture.txt",
      captureSha256: digest(capture),
      quote,
      quoteSha256: digest(quote),
    }],
    claims: Object.fromEntries(checks.map((check) => [check, [0]])),
    behaviorClaims: checks,
    behaviorReceipt,
  };
  return {
    evidenceRoot,
    adapter: { kind: "fixture-agent", pinnedVersion: "1.0.0", verificationId: "fixture-agent-1.0.0" },
    manifest: { schemaVersion: 4, adapters: { "fixture-agent-1.0.0": record } },
    record,
    receiptArtifact,
  };
}

async function withFixture(run) {
  const value = await fixture();
  try {
    await run(value);
  } finally {
    await rm(value.evidenceRoot, { recursive: true, force: true });
  }
}

test("independent evidence promotes only a complete hash-verified lifecycle receipt", async () => {
  await withFixture(async ({ adapter, manifest, evidenceRoot }) => {
    const result = verifyAdapterEvidence(adapter, {
      manifest,
      evidenceRoot,
      requiredChecks: checks,
      now: new Date("2026-08-01T13:00:00.000Z"),
    });
    assert.equal(result.supportLevel, "built-in-lifecycle-verified");
  });
});

test("fabricated proof labels and missing receipts cannot promote an adapter", async () => {
  await withFixture(async ({ adapter, manifest, evidenceRoot, record, receiptArtifact }) => {
    delete record.behaviorReceipt;
    record.proofLevel = "BEHAVIOR_CONFIRMED";
    assert.equal(verifyAdapterEvidence(adapter, { manifest, evidenceRoot, requiredChecks: checks }).supportLevel, "docs-confirmed-candidate");

    const replacement = await fixture();
    try {
      replacement.record.behaviorReceipt.proofLevel = "BEHAVIOR_CONFIRMED";
      assert.throws(() => verifyAdapterEvidence(replacement.adapter, {
        manifest: replacement.manifest,
        evidenceRoot: replacement.evidenceRoot,
        requiredChecks: checks,
      }), /may not assign its own proof level/);

      replacement.receiptArtifact.proofLevel = "BEHAVIOR_CONFIRMED";
      const receiptText = `${JSON.stringify(replacement.receiptArtifact, null, 2)}\n`;
      await writeFile(path.join(replacement.evidenceRoot, "receipts", "fixture.json"), receiptText);
      replacement.record.behaviorReceipt.receiptSha256 = digest(receiptText);
      delete replacement.record.behaviorReceipt.proofLevel;
      assert.throws(() => verifyAdapterEvidence(replacement.adapter, {
        manifest: replacement.manifest,
        evidenceRoot: replacement.evidenceRoot,
        requiredChecks: checks,
      }), /may not assign its own proof level/);
    } finally {
      await rm(replacement.evidenceRoot, { recursive: true, force: true });
    }
  });
});

test("changed hashes, stale sources, and mismatched versions fail closed", async () => {
  await withFixture(async ({ adapter, manifest, evidenceRoot, record }) => {
    record.sources[0].captureSha256 = "0".repeat(64);
    assert.throws(() => verifyAdapterEvidence(adapter, { manifest, evidenceRoot, requiredChecks: checks }), /capture hash changed/);
  });
  await withFixture(async ({ adapter, manifest, evidenceRoot }) => {
    assert.throws(() => verifyAdapterEvidence(adapter, {
      manifest,
      evidenceRoot,
      requiredChecks: checks,
      now: new Date("2026-10-31T13:00:00.000Z"),
    }), /Source 0 is stale/);
  });
  await withFixture(async ({ adapter, manifest, evidenceRoot }) => {
    adapter.pinnedVersion = "2.0.0";
    assert.throws(() => verifyAdapterEvidence(adapter, { manifest, evidenceRoot, requiredChecks: checks }), /version mismatch/);
  });
});

test("source provenance, authority, verification method, upstream hashes, and manifest schema fail closed", async () => {
  await withFixture(async ({ adapter, manifest, evidenceRoot, record }) => {
    record.sources[0].authority = "self-asserted";
    assert.throws(() => verifyAdapterEvidence(adapter, { manifest, evidenceRoot, requiredChecks: checks }), /not marked first-party/);
  });
  await withFixture(async ({ adapter, manifest, evidenceRoot, record }) => {
    record.sources[0].verificationMethod = "trust-me";
    assert.throws(() => verifyAdapterEvidence(adapter, { manifest, evidenceRoot, requiredChecks: checks }), /no supported deterministic verification method/);
  });
  await withFixture(async ({ adapter, manifest, evidenceRoot, record }) => {
    record.sources[0].freshness.upstreamSha256 = "fabricated";
    assert.throws(() => verifyAdapterEvidence(adapter, { manifest, evidenceRoot, requiredChecks: checks }), /no valid upstream SHA-256/);
  });
  await withFixture(async ({ adapter, manifest, evidenceRoot }) => {
    manifest.schemaVersion = 3;
    assert.throws(() => verifyAdapterEvidence(adapter, { manifest, evidenceRoot, requiredChecks: checks }), /manifest schema must be 4/);
  });
  await withFixture(async ({ adapter, manifest, evidenceRoot, record }) => {
    record.sources[0].repositorySource = {
      repository: "https://github.com/example/fixture",
      commit: "a".repeat(40),
      path: "docs/fixture.md",
    };
    assert.throws(() => verifyAdapterEvidence(adapter, { manifest, evidenceRoot, requiredChecks: checks }), /exactly one/);
  });
});

test("immutable release documentation is hash-verified without becoming stale", async () => {
  await withFixture(async ({ adapter, manifest, evidenceRoot, record }) => {
    const source = record.sources[0];
    delete source.canonicalUrl;
    source.repositorySource = {
      repository: "https://github.com/example/fixture",
      commit: "a".repeat(40),
      path: "docs/fixture.md",
    };
    source.freshness = { mode: "immutable-snapshot" };
    assert.equal(verifyAdapterEvidence(adapter, {
      manifest,
      evidenceRoot,
      requiredChecks: checks,
      now: new Date("2036-08-01T13:00:00.000Z"),
    }).supportLevel, "built-in-lifecycle-verified");

    const expected = Buffer.from("Official documentation\nfixture install command\n");
    const passing = await verifyRemoteSourceFreshness(manifest, {
      fetchImpl: async (url) => {
        assert.equal(url, `https://raw.githubusercontent.com/example/fixture/${"a".repeat(40)}/docs/fixture.md`);
        return { ok: true, status: 200, arrayBuffer: async () => expected };
      },
    });
    assert.equal(passing.checkedSources, 1);
    await assert.rejects(() => verifyRemoteSourceFreshness(manifest, {
      fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from("tampered") }),
    }), /Immutable repository source changed/);
  });
});

test("remote freshness verification detects upstream document changes", async () => {
  await withFixture(async ({ manifest, record }) => {
    const expected = Buffer.from("Official documentation\nfixture install command\n");
    const passing = await verifyRemoteSourceFreshness(manifest, {
      fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => expected }),
    });
    assert.equal(passing.checkedSources, 1);

    await assert.rejects(() => verifyRemoteSourceFreshness(manifest, {
      fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from("changed upstream") }),
    }), /Remote source content changed/);

    record.sources[0].freshness.sourceUrl = "http://insecure.example/source";
    await assert.rejects(() => verifyRemoteSourceFreshness(manifest, {
      fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => expected }),
    }), /no remote HTTPS source URL/);
  });
});

test("remote freshness verification rejects an upstream that no longer contains the quote", async () => {
  await withFixture(async ({ manifest, record }) => {
    // Hash matches the recorded upstream, but the quote is absent: the claim
    // must fail instead of resting on the locally stored capture.
    const bodyWithoutQuote = Buffer.from("Official documentation\nsomething else entirely\n");
    record.sources[0].freshness.upstreamSha256 = digest(bodyWithoutQuote);
    await assert.rejects(() => verifyRemoteSourceFreshness(manifest, {
      fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => bodyWithoutQuote }),
    }), /does not contain the exact quote/);
  });
});

test("receipt metadata, transcript, phase artifacts, and required phases are independently checked", async () => {
  await withFixture(async ({ adapter, manifest, evidenceRoot, record }) => {
    await writeFile(path.join(evidenceRoot, "receipts", "transcript.txt"), "tampered\n");
    assert.throws(() => verifyAdapterEvidence(adapter, { manifest, evidenceRoot, requiredChecks: checks }), /transcript hash changed/);
  });
  await withFixture(async ({ adapter, manifest, evidenceRoot, record, receiptArtifact }) => {
    receiptArtifact.agentVersion = "9.9.9";
    const receiptText = `${JSON.stringify(receiptArtifact, null, 2)}\n`;
    await writeFile(path.join(evidenceRoot, "receipts", "fixture.json"), receiptText);
    record.behaviorReceipt.receiptSha256 = digest(receiptText);
    assert.throws(() => verifyAdapterEvidence(adapter, { manifest, evidenceRoot, requiredChecks: checks }), /agentVersion does not match/);
  });
  await withFixture(async ({ adapter, manifest, evidenceRoot }) => {
    await writeFile(path.join(evidenceRoot, "receipts", "reconnect.txt"), "tampered\n");
    assert.throws(() => verifyAdapterEvidence(adapter, { manifest, evidenceRoot, requiredChecks: checks }), /reconnect output hash changed/);
  });
  await withFixture(async ({ adapter, manifest, evidenceRoot, record, receiptArtifact }) => {
    receiptArtifact.phases = receiptArtifact.phases.filter((phase) => phase.name !== "stop");
    const receiptText = `${JSON.stringify(receiptArtifact, null, 2)}\n`;
    await writeFile(path.join(evidenceRoot, "receipts", "fixture.json"), receiptText);
    record.behaviorReceipt.receiptSha256 = digest(receiptText);
    assert.throws(() => verifyAdapterEvidence(adapter, { manifest, evidenceRoot, requiredChecks: checks }), /missing a passing stop phase/);
  });
});
