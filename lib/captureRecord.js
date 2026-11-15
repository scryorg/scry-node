/**
 * The record `capture web` leaves next to its bundle once the validator has passed it, and the
 * check `upload DIR` makes before it decides to skip a second validation.
 *
 * The record lives OUTSIDE the bundle (a sibling file, `<dir>.scry-validated.json`), so the bundle
 * format, the zip and the service's own validation never see it. It holds a fingerprint of the
 * folder: every file's relative path, size and modification time (sorted), the SHA-256 of
 * scf.json, plus the deployer version and the vendored validator version. `upload` recomputes the
 * fingerprint and skips validation only on an exact match. No record, any difference (a file
 * added, removed, resized, touched, a different deployer or validator) means the full validation
 * runs as before. The fingerprint is a stat walk plus one small file read, a fraction of a second.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { listFiles, vendoredScfVersion } = require('./scf.js');

const RECORD_VERSION = 1;

function deployerVersion() {
    try {
        return require('../package.json').version;
    } catch {
        return 'unknown';
    }
}

/** `<dir>.scry-validated.json`, next to (never inside) the bundle folder. */
function recordPathFor(dir) {
    return `${path.resolve(dir)}.scry-validated.json`;
}

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Fingerprint a bundle folder.
 * @returns {{digest:string, files:number, manifestSha256:string|null}}
 */
function fingerprintDir(dir) {
    const files = listFiles(dir);
    const hash = crypto.createHash('sha256');
    for (const rel of files) {
        const st = fs.statSync(path.join(dir, ...rel.split('/')));
        hash.update(`${rel}\0${st.size}\0${Math.floor(st.mtimeMs)}\n`);
    }
    let manifestSha256 = null;
    try {
        manifestSha256 = sha256(fs.readFileSync(path.join(dir, 'scf.json')));
    } catch {
        manifestSha256 = null;
    }
    return { digest: hash.digest('hex'), files: files.length, manifestSha256 };
}

function expectedStamp() {
    return { version: RECORD_VERSION, deployer: deployerVersion(), validator: vendoredScfVersion() };
}

/** Write the record after the validator passed `dir`. Never throws: a failed write only costs a later validation. */
function writeCaptureRecord(dir) {
    try {
        const record = { ...expectedStamp(), ...fingerprintDir(dir) };
        fs.writeFileSync(recordPathFor(dir), `${JSON.stringify(record, null, 2)}\n`);
        return true;
    } catch {
        return false;
    }
}

/**
 * Does `dir` match the record capture left for it?
 * @returns {{match:boolean, reason:string, manifestSha256?:string}}
 */
function checkCaptureRecord(dir) {
    let record;
    try {
        record = JSON.parse(fs.readFileSync(recordPathFor(dir), 'utf8'));
    } catch {
        return { match: false, reason: 'no capture record' };
    }
    const stamp = expectedStamp();
    if (!record || record.version !== stamp.version || record.deployer !== stamp.deployer || record.validator !== stamp.validator) {
        return { match: false, reason: 'record is from another deployer or validator version' };
    }
    let now;
    try {
        now = fingerprintDir(dir);
    } catch {
        return { match: false, reason: 'folder could not be read' };
    }
    if (!record.manifestSha256 || record.digest !== now.digest || record.files !== now.files || record.manifestSha256 !== now.manifestSha256) {
        return { match: false, reason: 'folder changed since capture validated it' };
    }
    return { match: true, reason: 'matches the capture record', manifestSha256: now.manifestSha256 };
}

module.exports = { recordPathFor, fingerprintDir, writeCaptureRecord, checkCaptureRecord, sha256 };
