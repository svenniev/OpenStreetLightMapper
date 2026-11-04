import { describe, it } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { applyViewChain, invertViewChain, llaToEnu } from "@openstreetlightmapper/geo";
import { validateAutoImageMetadata } from "../db/autoValidation.js";
import {
  fetchPrepBytes,
  isPrepUrlAllowed,
  prepareAnalysisView,
  PrepError,
  type PrepViewInput,
} from "./prep.js";

function providerRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    camera_type: "perspective",
    camera_parameters: [0.8, 0, 0],
    width: 2048,
    height: 1536,
    exif_orientation: 1,
    geometry: { type: "Point", coordinates: [19.0, 47.0] },
    computed_geometry: { type: "Point", coordinates: [19.0001, 47.0001] },
    altitude: 110,
    computed_altitude: 120,
    computed_rotation: [0.1, 0.2, 0.3],
    compass_angle: 90,
    merge_cc: 7,
    captured_at: 1700000000000,
    is_pano: false,
    ...overrides,
  };
}

function prepInput(overrides: Partial<PrepViewInput> = {}): PrepViewInput {
  return {
    imageId: "img-1",
    meta: validateAutoImageMetadata(providerRecord(), "img-1", "seq-a"),
    geometrySource: "plan",
    thumbKind: "thumb_2048_url",
    thumbUrl: "https://scontent-ams4-1.xx.fbcdn.net/t.jpg",
    anchor: { lngLat: [19.0, 47.0], altM: 0 },
    analysisLongSidePx: 2048,
    encodeQuality: 90,
    ...overrides,
  };
}

/** Solid image with one white marker pixel at (markerX, markerY). */
async function markerJpeg(
  width: number,
  height: number,
  markerX: number,
  markerY: number,
  orientation?: number,
): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3, 0);
  const offset = (markerY * width + markerX) * 3;
  raw[offset] = 255;
  raw[offset + 1] = 255;
  raw[offset + 2] = 255;
  let pipeline = sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 100 });
  if (orientation !== undefined) pipeline = pipeline.withMetadata({ orientation });
  return pipeline.toBuffer();
}

function bytesFetch(body: Buffer, status = 200, headers?: Record<string, string>): typeof fetch {
  return (async () =>
    new Response(new Uint8Array(body), {
      status,
      headers: { "content-type": "image/jpeg", ...(headers ?? {}) },
    })) as unknown as typeof fetch;
}

async function brightestPixel(bytes: Buffer): Promise<{ x: number; y: number; value: number }> {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  let best = 0;
  let index = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    const value = data[i] + data[i + 1] + data[i + 2];
    if (value > best) {
      best = value;
      index = i / info.channels;
    }
  }
  return { x: index % info.width, y: Math.floor(index / info.width), value: best / 3 };
}

describe("prep URL allowlist", () => {
  it("allows the Mapillary CDN and rejects everything else", () => {
    assert.equal(isPrepUrlAllowed("https://scontent-ams4-1.xx.fbcdn.net/m1/v/abc"), true);
    assert.equal(isPrepUrlAllowed("https://SCONTENT.xx.FBCDN.NET/x.jpg"), true);
    assert.equal(isPrepUrlAllowed("http://scontent.xx.fbcdn.net/x.jpg"), false);
    assert.equal(isPrepUrlAllowed("https://user:pass@scontent.xx.fbcdn.net/x.jpg"), false);
    assert.equal(isPrepUrlAllowed("https://evil.example.com/x.jpg"), false);
    assert.equal(isPrepUrlAllowed("https://fbcdn.net.evil.example.com/x.jpg"), false);
    assert.equal(isPrepUrlAllowed("not a url"), false);
  });

  it("follows CDN redirects and refuses escapes", async () => {
    const body = await markerJpeg(64, 48, 5, 5);
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(String(url));
      if (calls.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://scontent-ams4-2.xx.fbcdn.net/final.jpg" },
        });
      }
      return new Response(new Uint8Array(body), { status: 200 });
    }) as unknown as typeof fetch;
    const bytes = await fetchPrepBytes("https://scontent-ams4-1.xx.fbcdn.net/start.jpg", { fetchImpl });
    assert.ok(bytes.length > 0);
    assert.deepEqual(calls, [
      "https://scontent-ams4-1.xx.fbcdn.net/start.jpg",
      "https://scontent-ams4-2.xx.fbcdn.net/final.jpg",
    ]);

    const escapeCalls: string[] = [];
    const escapeFetch = (async (url: string) => {
      escapeCalls.push(String(url));
      return new Response(null, { status: 302, headers: { location: "https://evil.example.com/x.jpg" } });
    }) as unknown as typeof fetch;
    await assert.rejects(fetchPrepBytes("https://scontent.xx.fbcdn.net/start.jpg", { fetchImpl: escapeFetch }), (error) => {
      assert.ok(error instanceof PrepError);
      assert.equal(error.code, "PREP_BAD_URL");
      return true;
    });
    assert.deepEqual(escapeCalls, ["https://scontent.xx.fbcdn.net/start.jpg"]);
  });

  it("reports fetch failures without provider bodies", async () => {
    const fetchImpl = bytesFetch(Buffer.from("nope"), 404);
    await assert.rejects(
      fetchPrepBytes("https://scontent.xx.fbcdn.net/missing.jpg", { fetchImpl }),
      (error) => {
        assert.ok(error instanceof PrepError);
        assert.equal(error.code, "PREP_FETCH_FAILED");
        assert.match(error.message, /status 404/);
        assert.doesNotMatch(error.message, /nope/);
        return true;
      },
    );
  });
});

describe("prepareAnalysisView", () => {
  it("prepares an upright view with pose and calibration passthrough", async () => {
    const body = await markerJpeg(2048, 1536, 1000, 700);
    const output = await prepareAnalysisView(prepInput({ fetchImpl: bytesFetch(body) }));
    assert.equal(output.width, 2048);
    assert.equal(output.height, 1536);
    assert.deepEqual(output.chain, []);
    assert.deepEqual(output.descriptor.camera, { cameraType: "perspective", cameraParameters: [0.8, 0, 0] });
    assert.deepEqual(
      output.descriptor.pose?.centerEnu,
      llaToEnu(19.0001, 47.0001, 120, { lngLat: [19.0, 47.0], altM: 0 }),
    );
    assert.deepEqual(output.descriptor.pose?.rotationWcAxisAngle, [0.1, 0.2, 0.3]);
    assert.equal(output.descriptor.pose?.positionSource, "computed");
    assert.equal(output.descriptor.source.observedExifOrientation, 1);
    assert.equal(output.descriptor.source.providerExifOrientation, 1);
    assert.ok(output.descriptor.source.metadataFields.includes("computed_rotation"));
    const bright = await brightestPixel(output.bytes);
    assert.ok(bright.value > 200);
    assert.ok(Math.abs(bright.x - 1000) <= 2 && Math.abs(bright.y - 700) <= 2);
  });

  it("matches the geo chain inverse on EXIF-rotated input", async () => {
    // Stored 120x160 portrait bytes, EXIF 6: upright is 160x120 landscape.
    const storedX = 30;
    const storedY = 100;
    const body = await markerJpeg(120, 160, storedX, storedY, 6);
    const input = prepInput({
      meta: validateAutoImageMetadata(providerRecord({ width: 120, height: 160 }), "img-1", "seq-a"),
      fetchImpl: bytesFetch(body),
    });
    const output = await prepareAnalysisView(input);
    assert.equal(output.width, 160);
    assert.equal(output.height, 120);
    assert.deepEqual(output.chain, [{ op: "orient", exif: 6, fromW: 120, fromH: 160 }]);
    // Sharp's auto-rotation must agree with the geo chain the worker inverts.
    const [expectedX, expectedY] = applyViewChain({ ops: output.chain }, [storedX, storedY]);
    const [backX, backY] = invertViewChain({ ops: output.chain }, [expectedX, expectedY]);
    assert.deepEqual([Math.round(backX), Math.round(backY)], [storedX, storedY]);
    const bright = await brightestPixel(output.bytes);
    assert.ok(bright.value > 200);
    assert.ok(Math.abs(bright.x - expectedX) <= 2 && Math.abs(bright.y - expectedY) <= 2);
  });

  it("downscales long images and records the resize", async () => {
    const body = await markerJpeg(4000, 3000, 2000, 1500);
    const input = prepInput({
      meta: validateAutoImageMetadata(providerRecord({ width: 4000, height: 3000 }), "img-1", "seq-a"),
      fetchImpl: bytesFetch(body),
    });
    const output = await prepareAnalysisView(input);
    assert.equal(output.width, 2048);
    assert.equal(output.height, 1536);
    assert.deepEqual(output.chain, [{ op: "resize", fromW: 4000, fromH: 3000, toW: 2048, toH: 1536 }]);
  });

  it("keeps detection-only views with null pose or camera", async () => {
    const body = await markerJpeg(2048, 1536, 10, 10);
    const noRotation = await prepareAnalysisView(
      prepInput({
        meta: validateAutoImageMetadata(providerRecord({ computed_rotation: null }), "img-1", "seq-a"),
        fetchImpl: bytesFetch(body),
      }),
    );
    assert.ok(noRotation.descriptor.camera);
    assert.equal(noRotation.descriptor.pose, null);

    const fisheye = await prepareAnalysisView(
      prepInput({
        meta: validateAutoImageMetadata(providerRecord({ camera_type: "fisheye" }), "img-1", "seq-a"),
        fetchImpl: bytesFetch(body),
      }),
    );
    assert.equal(fisheye.descriptor.camera, null);
    assert.ok(fisheye.descriptor.pose);
  });

  it("supports flat equirectangular panoramas without parameters", async () => {
    const body = await markerJpeg(2048, 1024, 100, 100);
    const output = await prepareAnalysisView(
      prepInput({
        meta: validateAutoImageMetadata(
          providerRecord({ camera_type: "equirectangular", camera_parameters: [], width: 2048, height: 1024, is_pano: true }),
          "img-1",
          "seq-a",
        ),
        fetchImpl: bytesFetch(body),
      }),
    );
    assert.deepEqual(output.descriptor.camera, { cameraType: "equirectangular", cameraParameters: [] });
    assert.ok(output.descriptor.pose);
  });

  it("refuses mirrored EXIF, mismatched dimensions, and garbage bytes", async () => {
    const mirrored = await markerJpeg(64, 48, 5, 5, 2);
    await assert.rejects(prepareAnalysisView(prepInput({ fetchImpl: bytesFetch(mirrored) })), (error) => {
      assert.ok(error instanceof PrepError);
      assert.equal(error.code, "PREP_UNSUPPORTED_EXIF");
      return true;
    });

    const square = await markerJpeg(1024, 1024, 5, 5);
    await assert.rejects(prepareAnalysisView(prepInput({ fetchImpl: bytesFetch(square) })), (error) => {
      assert.ok(error instanceof PrepError);
      assert.equal(error.code, "PREP_DIMENSION_MISMATCH");
      return true;
    });

    await assert.rejects(
      prepareAnalysisView(prepInput({ fetchImpl: bytesFetch(Buffer.from("not-an-image")) })),
      (error) => {
        assert.ok(error instanceof PrepError);
        assert.equal(error.code, "PREP_DECODE_FAILED");
        return true;
      },
    );
  });
});
