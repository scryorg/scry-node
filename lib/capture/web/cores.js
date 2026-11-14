/**
 * How many CPU cores this process may really use, and the worker count that follows.
 *
 * `os.availableParallelism()` honours the affinity mask (taskset, cpuset), but not a CFS quota:
 * a container limited to 2 CPUs on a 64-core host still reports 64. So the cgroup quota is read
 * too and the smaller number wins.
 */
const fs = require('fs');
const os = require('os');

/** Change here when measured numbers say otherwise. */
const MAX_DEFAULT_WORKERS = 4;

function readQuota(readFile) {
    try {
        const [quota, period] = String(readFile('/sys/fs/cgroup/cpu.max')).trim().split(/\s+/);
        if (quota && quota !== 'max' && Number(quota) > 0 && Number(period) > 0) {
            return { cpus: Number(quota) / Number(period), source: 'cgroup-v2' };
        }
        return null;
    } catch {
        // not cgroup v2
    }
    try {
        const quota = Number(String(readFile('/sys/fs/cgroup/cpu/cpu.cfs_quota_us')).trim());
        const period = Number(String(readFile('/sys/fs/cgroup/cpu/cpu.cfs_period_us')).trim());
        if (quota > 0 && period > 0) return { cpus: quota / period, source: 'cgroup-v1' };
    } catch {
        // no cgroup limit readable
    }
    return null;
}

/**
 * @returns {{cores:number, source:'os'|'cgroup-v1'|'cgroup-v2', os:number, cgroup:number|null}}
 */
function coresSeen(deps = {}) {
    const availableParallelism = deps.availableParallelism
        || (typeof os.availableParallelism === 'function' ? () => os.availableParallelism() : () => os.cpus().length);
    const readFile = deps.readFile || ((file) => fs.readFileSync(file, 'utf8'));
    const fromOs = Math.max(1, Math.floor(Number(availableParallelism()) || 1));
    const quota = readQuota(readFile);
    const cgroup = quota ? Math.max(1, Math.floor(quota.cpus)) : null;
    if (cgroup !== null && cgroup < fromOs) return { cores: cgroup, source: quota.source, os: fromOs, cgroup };
    return { cores: fromOs, source: cgroup !== null && cgroup === fromOs ? quota.source : 'os', os: fromOs, cgroup };
}

function defaultWorkers(cores) {
    return Math.max(1, Math.min(MAX_DEFAULT_WORKERS, Math.floor(Number(cores) || 1)));
}

module.exports = { coresSeen, defaultWorkers, MAX_DEFAULT_WORKERS };
