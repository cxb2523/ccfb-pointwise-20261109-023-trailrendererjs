// Run with: node js/TrailRenderer.benchmark.js
// Compares the ring-buffer rewrite (TrailRenderer.js) against the untouched
// pre-rewrite snapshot (TrailRenderer.baseline.js) using the exact same
// parameters: same requested length, same head geometry, same 1000-frame
// target-motion pattern (see benchmarkAdvance in TrailRenderer.js).
import * as THREE from 'three';
import { TrailRenderer as TrailRendererNew } from './TrailRenderer.js';
import { TrailRenderer as TrailRendererBaseline } from './TrailRenderer.baseline.js';

const REQUESTED_LENGTH = 300;
const ITERATIONS = 1000;

function run(TrailRendererClass, label) {
    const scene = { add() {}, remove() {} };
    const trail = new TrailRendererClass(scene, false);
    const material = TrailRendererClass.createBaseMaterial();
    const target = new THREE.Object3D();
    const headGeometry = [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)];
    trail.initialize(material, REQUESTED_LENGTH, false, 0, headGeometry, target);
    trail.activate();

    // Baseline has no benchmarkAdvance()/allocation counter - time it with the
    // same loop shape manually so both runs are driven identically.
    if (typeof trail.benchmarkAdvance === 'function') {
        const result = trail.benchmarkAdvance(ITERATIONS);
        console.log(`${label}: avg=${result.avgMs.toFixed(4)}ms/frame total=${result.totalMs.toFixed(2)}ms allocCount=${result.allocCount}`);
        return result;
    }

    const start = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
        target.position.set(Math.sin(i * 0.05) * 10, Math.cos(i * 0.05) * 10, i * 0.01);
        target.rotation.y = i * 0.01;
        trail.advance();
    }
    const totalMs = performance.now() - start;
    const avgMs = totalMs / ITERATIONS;
    console.log(`${label}: avg=${avgMs.toFixed(4)}ms/frame total=${totalMs.toFixed(2)}ms allocCount=n/a`);
    return { iterations: ITERATIONS, totalMs, avgMs };
}

console.log(`Benchmarking ${ITERATIONS} advance() calls, requestedLength=${REQUESTED_LENGTH}\n`);
const baseline = run(TrailRendererBaseline, 'baseline (pre-rewrite)');
const rewritten = run(TrailRendererNew, 'rewritten (ring buffer)');

const speedup = baseline.avgMs / rewritten.avgMs;
console.log(`\nspeedup: ${speedup.toFixed(2)}x`);
