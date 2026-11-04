import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ITEM_CLAIM_LEASE_MS_DEFAULT,
  StorageValidationError,
  validateArtifactMeta,
  validateItemClaim,
  validateItemCompletion,
  validateItemRegistration,
  validateOptionalOwner,
  validateResultInput,
  validateSessionInput,
  validateSnapshotInput,
  validateWorkspaceInput,
} from "./validation.js";

function minimalSession(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    key: "street-1",
    sessionId: "s-street-1",
    mode: "manual",
    context: { streetId: "street-1", streetDisplayName: "Main St", streetSource: "osm" },
    activeStep: "detect",
    detection: { status: "idle" },
    observations: {},
    assets: {},
    obsOrder: [],
    assetOrder: [],
    obsCounter: 0,
    assetCounter: 0,
    sources: {},
    views: {},
    viewOrder: [],
    manifest: null,
    concepts: [{ id: "concept-pole", text: "street light pole" }],
    conceptCounter: 1,
    runs: [],
    runCounter: 0,
    stagedTest: null,
    finishedPreview: null,
  };
}

function minimalWorkspace(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: "Test workspace",
    roi: null,
    imagerySnapshotId: null,
    imagerySelection: {},
    streetSnapshotId: null,
    streetSelection: {},
    preparation: { runState: "not_started", plan: null },
    activeSessionKey: null,
    sessionKeys: [],
  };
}

describe("storage validation", () => {
  it("rejects unknown schema versions everywhere", () => {
    for (const validate of [
      validateWorkspaceInput,
      validateSessionInput,
      validateSnapshotInput,
      validateItemRegistration,
      validateItemCompletion,
      validateResultInput,
    ]) {
      assert.throws(() => validate({ schemaVersion: 99 }), (error: unknown) => {
        assert.ok(error instanceof StorageValidationError);
        assert.equal(error.code, "STORAGE_SCHEMA_VERSION");
        return true;
      });
    }
  });

  it("validates a minimal workspace and rejects blank names", () => {
    const parsed = validateWorkspaceInput(minimalWorkspace());
    assert.equal(parsed.name, "Test workspace");
    assert.throws(
      () => validateWorkspaceInput({ ...minimalWorkspace(), name: "  " }),
      (error: unknown) => {
        assert.ok(error instanceof StorageValidationError);
        assert.equal(error.code, "STORAGE_BAD_REQUEST");
        return true;
      },
    );
  });

  it("rejects invalid RoI coordinates", () => {
    assert.throws(
      () =>
        validateWorkspaceInput({
          ...minimalWorkspace(),
          roi: {
            revision: 1,
            shape: "rectangle",
            polygon: { type: "Polygon", coordinates: [[[500, 0], [1, 1], [2, 2], [500, 0]]] },
            bbox: [0, 0, 1, 1],
            areaSqM: 10,
            valid: true,
          },
        }),
      /must be finite WGS84/,
    );
  });

  it("caps imagery snapshot records with an actionable error", () => {
    const seeds = Array.from({ length: 5001 }, (_, index) => ({
      id: `img-${index}`,
      coordinate: [19, 47],
      coordinateSource: "geometry",
      originalCoordinate: null,
      computedCoordinate: null,
      capturedAt: null,
      isPano: false,
      sequenceId: null,
    }));
    assert.throws(
      () =>
        validateSnapshotInput({
          schemaVersion: 1,
          snapshotId: "sn-1",
          kind: "imagery-discovery",
          payload: {
            query: {},
            warnings: [],
            status: "results",
            everSearched: true,
            seeds,
            hydrated: [],
            truncatedCount: 0,
          },
        }),
      (error: unknown) => {
        assert.ok(error instanceof StorageValidationError);
        assert.equal(error.code, "STORAGE_RECORD_LIMIT");
        assert.match(error.message, /smaller working set/);
        return true;
      },
    );
  });

  it("rejects demo sessions and demo observations", () => {
    assert.throws(() => validateSessionInput({ ...minimalSession(), mode: "demo" }), (error: unknown) => {
      assert.ok(error instanceof StorageValidationError);
      assert.equal(error.code, "SESSION_MODE_NOT_PERSISTED");
      return true;
    });
    const session = minimalSession();
    session.observations = {
      "obs-1": {
        id: "obs-1",
        imageId: "img-1",
        viewId: null,
        category: "pole",
        description: "demo",
        imageRegion: null,
        mask: null,
        maskStale: false,
        origin: "demo",
        provenance: null,
        mode: "manual",
        decision: "pending",
        note: "",
      },
    };
    assert.throws(() => validateSessionInput(session), (error: unknown) => {
      assert.ok(error instanceof StorageValidationError);
      assert.equal(error.code, "CONTEXT_MIXING");
      return true;
    });
  });

  it("rejects stored masks, media handles, and run-item objects", () => {
    const withMask = minimalSession();
    withMask.observations = {
      "obs-1": {
        id: "obs-1",
        imageId: "img-1",
        viewId: null,
        category: "pole",
        description: "x",
        imageRegion: null,
        mask: { svgPath: "M0 0h1v1H0z", width: 1, height: 1, bounds: { left: 0, top: 0, right: 1, bottom: 1 } },
        maskStale: false,
        origin: "manual",
        provenance: null,
        mode: "manual",
        decision: "pending",
        note: "",
      },
    };
    assert.throws(() => validateSessionInput(withMask), /mask must be null/);

    const withHandle = minimalSession();
    withHandle.views = {
      "view-1": {
        viewId: "view-1",
        imageId: "img-1",
        fullWidth: 10,
        fullHeight: 10,
        orientation: 1,
        isPano: false,
        crop: null,
        width: 10,
        height: 10,
        mediaHandle: "live-handle",
        fullyReviewed: false,
      },
    };
    assert.throws(() => validateSessionInput(withHandle), /mediaHandle must be empty/);

    const withObjects = minimalSession();
    withObjects.views = {
      "view-1": {
        viewId: "view-1",
        imageId: "img-1",
        fullWidth: 10,
        fullHeight: 10,
        orientation: 1,
        isPano: false,
        crop: null,
        width: 10,
        height: 10,
        mediaHandle: "",
        fullyReviewed: false,
      },
    };
    withObjects.runs = [
      {
        runId: "run-1",
        kind: "batch",
        items: [
          {
            itemId: "item-1",
            requestId: "req-1",
            viewId: "view-1",
            conceptId: "concept-pole",
            conceptText: "street light pole",
            status: "succeeded",
            objects: [{ providerObjectId: "p1" }],
            model: "sam-3.1",
            error: null,
            attempts: 1,
            truncated: false,
            imported: false,
            invalidDiscarded: 0,
            startedAt: null,
            finishedAt: null,
          },
        ],
      },
    ];
    assert.throws(() => validateSessionInput(withObjects), /objects must be empty/);
  });

  it("rejects broken support links with a stable code", () => {
    const session = minimalSession();
    session.assets = {
      "asset-1": {
        id: "asset-1",
        category: "luminaire",
        observationIds: [],
        confirmed: false,
        support: { kind: "pole", poleAssetId: "asset-9" },
        placement: { kind: "unknown", explicit: false },
        mode: "manual",
        streetSource: "osm",
        note: "",
      },
    };
    assert.throws(() => validateSessionInput(session), (error: unknown) => {
      assert.ok(error instanceof StorageValidationError);
      assert.equal(error.code, "BROKEN_SUPPORT_LINK");
      return true;
    });
  });

  it("validates item registration and completion transitions", () => {
    const artifactId = "a".repeat(24);
    const registration = validateItemRegistration({
      schemaVersion: 1,
      runId: "run-1",
      itemId: "item-1",
      kind: "batch",
      viewId: "view-1",
      conceptId: "concept-pole",
      prompt: "street light pole",
      categoryIntent: "pole",
      model: null,
      viewDescriptor: { width: 10, height: 10 },
      artifactId,
      supersedes: null,
    });
    assert.equal(registration.artifactId, artifactId);
    assert.throws(
      () =>
        validateItemCompletion({
          schemaVersion: 1,
          status: "succeeded",
          objects: [],
          model: "sam-3.1",
          truncated: false,
          invalidDiscarded: 0,
          error: null,
          finishedAt: new Date().toISOString(),
        }),
      /at least one object/,
    );
    assert.throws(
      () =>
        validateItemCompletion({
          schemaVersion: 1,
          status: "failed",
          objects: [
            { providerObjectId: "p1", box: { x: 0, y: 0, w: 0.1, h: 0.1 }, confidence: null, mask: null },
          ],
          model: null,
          truncated: false,
          invalidDiscarded: 0,
          error: "boom",
          finishedAt: new Date().toISOString(),
        }),
      /must not carry objects/,
    );
  });

  it("validates item claims, owners, and lease bounds", () => {
    const claim = validateItemClaim({ owner: "worker-a" });
    assert.equal(claim.owner, "worker-a");
    assert.equal(claim.leaseMs, ITEM_CLAIM_LEASE_MS_DEFAULT);
    assert.equal(validateItemClaim({ owner: "worker-a", leaseMs: 5000 }).leaseMs, 5000);
    assert.throws(() => validateItemClaim({}), /owner/);
    assert.throws(() => validateItemClaim({ owner: "worker-a", leaseMs: 999 }), /leaseMs/);
    assert.throws(() => validateItemClaim({ owner: "worker-a", leaseMs: 600001 }), /leaseMs/);

    assert.equal(validateOptionalOwner(undefined), null);
    assert.equal(validateOptionalOwner(null), null);
    assert.equal(validateOptionalOwner({}), null);
    assert.equal(validateOptionalOwner({ owner: "worker-a" }), "worker-a");
    assert.throws(() => validateOptionalOwner({ owner: "" }), /owner/);

    const completion = validateItemCompletion({
      schemaVersion: 1,
      status: "empty",
      objects: [],
      model: null,
      truncated: false,
      invalidDiscarded: 0,
      error: null,
      finishedAt: new Date().toISOString(),
    });
    assert.equal(completion.owner, null);
    const owned = validateItemCompletion({
      schemaVersion: 1,
      status: "empty",
      objects: [],
      model: null,
      truncated: false,
      invalidDiscarded: 0,
      error: null,
      finishedAt: new Date().toISOString(),
      owner: "worker-a",
    });
    assert.equal(owned.owner, "worker-a");
  });

  it("validates artifact metadata and hashes", () => {
    assert.throws(() => validateArtifactMeta({}), /contentHash/);
    const meta = validateArtifactMeta({
      contentHash: "b".repeat(64),
      mime: "image/png",
      width: 4,
      height: 4,
      byteLength: 100,
      imageId: "img-1",
      viewId: null,
      orientation: 1,
      crop: null,
      attribution: "Mapillary",
      sourceUrl: "https://www.mapillary.com/map/im/img-1",
    });
    assert.equal(meta.mime, "image/png");
  });

  it("validates reviewed results and artifact hash shape", () => {
    assert.throws(
      () =>
        validateResultInput({
          schemaVersion: 1,
          resultId: "rs-1",
          sessionRevision: 2,
          inputRevision: 1,
          counts: {},
          limitations: [],
          provenance: {},
          snapshot: {},
          artifactIds: ["not-a-hash"],
        }),
      /stored evidence IDs/,
    );
  });

  it("rejects slashes and whitespace in client IDs", () => {
    assert.throws(
      () => validateWorkspaceInput({ ...minimalWorkspace(), sessionKeys: ["a/b"] }),
      /slashes/,
    );
  });
});
