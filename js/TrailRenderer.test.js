// Plain-Node test file, no test framework: run with `node js/TrailRenderer.test.js`.
// Requires the "three" shim in node_modules/three/package.json pointing at
// js/libs/three.module.min.js (already set up; see package.json "type": "module").
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TrailRenderer } from './TrailRenderer.js';

let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`ok - ${name}`);
    } catch (err) {
        console.error(`FAIL - ${name}`);
        console.error(err);
        process.exitCode = 1;
    }
}

function makeScene() {
    return { add() {}, remove() {} };
}

// requestedLength=5 -> ring capacity (trail.length) = 6. "maxLength" in the task
// description is interpreted here as this ring capacity: the actual buffer size
// that governs when the head pointer wraps and starts overwriting the tail.
function createTrail(requestedLength) {
    const scene = makeScene();
    const trail = new TrailRenderer(scene, false);
    const material = TrailRenderer.createBaseMaterial();
    const target = new THREE.Object3D();
    const headGeometry = [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)];
    trail.initialize(material, requestedLength, false, 0, headGeometry, target);
    trail.activate();
    return trail;
}

function advanceN(trail, n) {
    for (let i = 0; i < n; i++) {
        trail.targetObject.position.set(i * 0.1, i * 0.05, 0);
        trail.advance();
    }
}

// Alive nodes sorted tail -> head by nodeID (logical creation order), independent
// of physical ring-slot storage order.
function aliveNodesInLogicalOrder(trail) {
    const pairs = [];
    for (let i = 0; i < trail.length; i++) {
        const id = trail.nodeIDs[i];
        if (id >= 0) pairs.push({ nodeIndex: i, nodeID: id });
    }
    pairs.sort((a, b) => a.nodeID - b.nodeID);
    return pairs;
}

function isChunkZero(indices, chunkStart, chunkLen) {
    for (let i = 0; i < chunkLen; i++) {
        if (indices[chunkStart + i] !== 0) return false;
    }
    return true;
}

// Index-sequence invariant (no off-by-one head/tail wraparound bug):
// - exactly one FacesPerNode-sized chunk is all-zero (degenerate), and it must sit
//   at physical slot `trail.currentEnd` (the head's own outgoing-connection slot,
//   which never has a successor yet).
// - every other populated slot k must wire vertex-node k to vertex-node wrap(k+1),
//   and that destination node's nodeID must be exactly one greater than k's nodeID
//   (catches wrong-neighbor wiring from a modulo mistake).
// - visible vertex/face count matches currentLength exactly.
function assertRingInvariants(trail) {
    const N = trail.length;
    const V = trail.VerticesPerNode;
    const indices = trail.geometry.getIndex().array;
    const drawRange = trail.geometry.drawRange;
    const faceIdxPerNode = trail.FaceIndicesPerNode;
    const saturated = trail.currentLength >= N;

    // While filling (currentLength < N) the draw range only ever covers the
    // segments that have been genuinely connectNodes()'d so far - this is the
    // "local range expansion" the task asks for. Once saturated it covers all
    // N slots, one of which is always the degenerate head placeholder below.
    const expectedDrawCount = saturated
        ? trail.currentLength * faceIdxPerNode
        : (trail.currentLength - 1) * faceIdxPerNode;
    assert.equal(drawRange.start, 0);
    assert.equal(drawRange.count, expectedDrawCount);

    const alive = aliveNodesInLogicalOrder(trail);
    assert.equal(alive.length, trail.currentLength, 'visible vertex count (alive nodes) must equal currentLength');

    if (trail.currentLength < 2) return; // nothing connected yet to verify

    const drawnSlotCount = saturated ? N : (trail.currentLength - 1);
    let zeroChunks = 0;
    let zeroChunkSlot = -1;
    for (let slot = 0; slot < drawnSlotCount; slot++) {
        const chunkStart = slot * faceIdxPerNode;
        if (isChunkZero(indices, chunkStart, faceIdxPerNode)) {
            zeroChunks++;
            zeroChunkSlot = slot;
            continue;
        }
        // Non-degenerate chunk: must connect slot -> wrap(slot+1) and be adjacent in nodeID.
        const destSlot = trail._wrapIndex(slot + 1);
        const srcVertexIndex = slot * V;
        const destVertexIndex = destSlot * V;
        assert.equal(indices[chunkStart], srcVertexIndex, `slot ${slot} src vertex index`);
        assert.equal(indices[chunkStart + 1], destVertexIndex, `slot ${slot} dest vertex index`);
        assert.equal(trail.nodeIDs[destSlot], trail.nodeIDs[slot] + 1, `slot ${slot} -> ${destSlot} nodeID must be adjacent`);
    }
    if (saturated) {
        // Exactly one slot (the head's own outgoing slot) must be the degenerate
        // placeholder - this is the invariant that an off-by-one in the ring math
        // would break: it would show up as 0 (an extra triangle drawn) or 2+
        // (a missing triangle) degenerate chunks, or a zero chunk at the wrong slot.
        assert.equal(zeroChunks, 1, 'exactly one degenerate (disconnected) chunk expected once the ring is full');
        assert.equal(zeroChunkSlot, trail.currentEnd, 'the degenerate chunk must sit at the head slot (currentEnd)');
    } else {
        assert.equal(zeroChunks, 0, 'no degenerate chunk should be inside the draw range while the trail is still filling');
    }
}

// Index of the pair, within the logical (nodeID-sorted) alive list, where the
// physical ring storage actually wraps (i.e. slot index drops). That is the
// exact spot where a UV or alpha seam/jump would show up if the ring-offset
// remapping were wrong.
function findPhysicalWrapSeam(alive) {
    for (let i = 1; i < alive.length; i++) {
        if (alive[i].nodeIndex < alive[i - 1].nodeIndex) return i;
    }
    return -1;
}

function assertUVContinuity(trail) {
    const uv = trail.geometry.getAttribute('uv').array;
    const comp = TrailRenderer.UVComponentCount;
    const alive = aliveNodesInLogicalOrder(trail);
    const sValues = alive.map(({ nodeIndex }) => uv[nodeIndex * trail.VerticesPerNode * comp]);

    const expectedStep = 1 / trail.length;
    for (let i = 1; i < sValues.length; i++) {
        const step = sValues[i] - sValues[i - 1];
        assert.ok(step > 0, `uv s must be strictly increasing in logical order at index ${i}`);
        assert.ok(Math.abs(step - expectedStep) < 1e-6, `uv s step must be uniform (no jump) at index ${i}`);
    }

    const expectedTailS = (trail.currentNodeID - trail.currentLength) / trail.length;
    const expectedHeadS = (trail.currentNodeID - 1) / trail.length;
    assert.ok(Math.abs(sValues[0] - expectedTailS) < 1e-6, 'uv tail (oldest) s value');
    assert.ok(Math.abs(sValues[sValues.length - 1] - expectedHeadS) < 1e-6, 'uv head (newest) s value');

    const seam = findPhysicalWrapSeam(alive);
    if (seam >= 0) {
        const step = sValues[seam] - sValues[seam - 1];
        assert.ok(Math.abs(step - expectedStep) < 1e-6, 'uv must stay continuous exactly at the physical ring-wrap seam');
    }
}

function assertAlphaContinuity(trail) {
    const alive = aliveNodesInLogicalOrder(trail);
    const fractions = alive.map(({ nodeIndex }) => trail.getVertexFraction(nodeIndex));
    const minID = trail.material.uniforms.minID.value;
    const maxID = trail.material.uniforms.maxID.value;
    const expectedStep = 1 / (maxID - minID);

    for (let i = 1; i < fractions.length; i++) {
        const diff = fractions[i - 1] - fractions[i];
        assert.ok(Math.abs(diff - expectedStep) < 1e-6, `alpha fraction step must be continuous at index ${i}`);
    }

    const seam = findPhysicalWrapSeam(alive);
    if (seam >= 0) {
        const diff = fractions[seam - 1] - fractions[seam];
        assert.ok(Math.abs(diff - expectedStep) < 1e-6, 'alpha gradient must not flicker/tear exactly at the physical ring-wrap seam');
    }
}

// requestedLength=5 => ring capacity N = trail.length = 6.
const REQUESTED_LENGTH = 5;

function scenario(advanceCount, label) {
    test(`${label}: index sequence has no off-by-one`, () => {
        const trail = createTrail(REQUESTED_LENGTH);
        advanceN(trail, advanceCount);
        assertRingInvariants(trail);
    });

    test(`${label}: UV longitudinal coordinate stays monotonic/continuous across the wrap`, () => {
        const trail = createTrail(REQUESTED_LENGTH);
        advanceN(trail, advanceCount);
        assertUVContinuity(trail);
    });

    test(`${label}: alpha gradient is continuous across the wrap seam`, () => {
        const trail = createTrail(REQUESTED_LENGTH);
        advanceN(trail, advanceCount);
        assertAlphaContinuity(trail);
    });
}

const N = REQUESTED_LENGTH + 1; // ring capacity ("maxLength")
scenario(N, `length == maxLength (${N})`);
scenario(N + 1, `length == maxLength+1 (${N + 1})`);
scenario(N * 3, `length == maxLength*3 (${N * 3})`);

test('advance() performs zero Float32Array allocations across 300+ calls', () => {
    const trail = createTrail(REQUESTED_LENGTH);
    advanceN(trail, 5); // prime the ring past the filling phase
    const before = trail.float32ArrayAllocCount;
    advanceN(trail, 320);
    const after = trail.float32ArrayAllocCount;
    assert.equal(after - before, 0, 'advance() must not allocate any Float32Array');
});

test('benchmarkAdvance runs and reports timing/allocation stats', () => {
    const trail = createTrail(REQUESTED_LENGTH);
    const before = trail.float32ArrayAllocCount;
    const result = trail.benchmarkAdvance(200);
    assert.equal(result.iterations, 200);
    assert.ok(result.avgMs >= 0);
    assert.equal(result.allocCount, 0, 'benchmarkAdvance must not allocate any Float32Array either');
    assert.equal(trail.float32ArrayAllocCount, before);
});

console.log(`\n${passed} test(s) passed.`);
if (process.exitCode) {
    console.error('Some tests FAILED.');
} else {
    console.log('All tests passed.');
}
