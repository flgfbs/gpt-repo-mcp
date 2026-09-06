#!/usr/bin/env python3
"""Owner-local, fixed nine-target MCP runtime overlay. No MCP tool or installer API."""
import argparse
import contextlib
import ctypes
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import stat
import subprocess
import sys
import tarfile

TARGETS = (
    "node_modules/@esbuild/darwin-arm64", "node_modules/esbuild",
    "node_modules/fast-uri", "node_modules/hasown", "node_modules/qs",
    "node_modules/side-channel", "node_modules/tsx",
    "node_modules/.package-lock.json", "dist",
)
SCHEMA = "mcp-fixed-runtime-execution.v1"
MAX_BYTES = 64 * 1024 * 1024
DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


class Blocked(Exception):
    """Content-free failure; retained state must not be deleted or replayed."""


def need(condition, code):
    if not condition:
        raise Blocked(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def identity(s):
    return [s.st_dev, s.st_ino, s.st_uid, s.st_gid, stat.S_IMODE(s.st_mode)]


def stable(s):
    return identity(s) + [s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_nlink]


@contextlib.contextmanager
def directory(path):
    """Open every ancestor without following links, including the final name."""
    path = Path(path)
    need(path.is_absolute() and ".." not in path.parts, "UNSAFE_ABSOLUTE_PATH")
    fd = os.open("/", DIR)
    try:
        for part in path.parts[1:]:
            child = os.open(part, DIR, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def read(path, limit=MAX_BYTES):
    path = Path(path)
    with directory(path.parent) as parent:
        before = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
        need(stat.S_ISREG(before.st_mode) and before.st_size <= limit, "UNSAFE_FILE")
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            need(stable(os.fstat(fd)) == stable(before), "OPEN_DRIFT")
            chunks, count = [], 0
            while True:
                chunk = os.read(fd, min(65536, limit + 1 - count))
                if not chunk:
                    break
                chunks.append(chunk)
                count += len(chunk)
                need(count <= limit, "OVERSIZED_FILE")
            need(stable(os.fstat(fd)) == stable(before), "READ_DRIFT")
            need(stable(os.stat(path.name, dir_fd=parent, follow_symlinks=False)) == stable(before),
                 "NAME_DRIFT")
            return b"".join(chunks)
        finally:
            os.close(fd)


def exact_json(path, digest):
    raw = read(path)
    need(sha(raw) == digest, "ARTIFACT_DIGEST_DRIFT")
    def unique(pairs):
        result = {}
        for key, value in pairs:
            need(key not in result, "DUPLICATE_JSON_KEY")
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=unique)


def exclusive(path, raw, mode=0o600):
    with directory(Path(path).parent) as parent:
        fd = os.open(Path(path).name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     mode, dir_fd=parent)
        try:
            os.fchmod(fd, mode)
            with os.fdopen(fd, "wb", closefd=False) as output:
                need(output.write(raw) == len(raw), "SHORT_WRITE")
                output.flush()
                os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(parent)
    need(read(path) == raw, "WRITE_READBACK_DRIFT")


def mkdir(path, mode=0o700):
    with directory(Path(path).parent) as parent:
        os.mkdir(Path(path).name, mode, dir_fd=parent)
        fd = os.open(Path(path).name, DIR, dir_fd=parent)
        try:
            os.fchmod(fd, mode)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(parent)


def exchange(left, right, expected_left, expected_right):
    """No rename fallback: both names must exist and atomically exchange."""
    lib = ctypes.CDLL(None, use_errno=True)
    with directory(Path(left).parent) as a, directory(Path(right).parent) as b:
        need(identity(os.stat(Path(left).name, dir_fd=a, follow_symlinks=False)) == expected_left and
             identity(os.stat(Path(right).name, dir_fd=b, follow_symlinks=False)) == expected_right,
             "EXCHANGE_IDENTITY_DRIFT")
        if sys.platform == "darwin":
            call, flag = lib.renameatx_np, 2  # RENAME_SWAP
        elif sys.platform.startswith("linux"):
            call, flag = lib.renameat2, 2  # RENAME_EXCHANGE (fixture CI)
        else:
            raise Blocked("ATOMIC_EXCHANGE_UNAVAILABLE")
        call.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p,
                         ctypes.c_uint]
        call.restype = ctypes.c_int
        result = call(a, os.fsencode(Path(left).name), b, os.fsencode(Path(right).name), flag)
        need(result == 0, "ATOMIC_EXCHANGE_FAILED")
        os.fsync(a)
        os.fsync(b)


def private_json(path):
    s = Path(path).lstat()
    need(stat.S_ISREG(s.st_mode) and s.st_uid == os.getuid() and s.st_nlink == 1 and
         stat.S_IMODE(s.st_mode) == 0o600, "UNSAFE_CONTROL_FILE")
    raw = read(path)
    need(stable(Path(path).lstat()) == stable(s), "CONTROL_FILE_DRIFT")
    value = json.loads(raw)
    need(encoded(value) == raw, "NONCANONICAL_CONTROL_FILE")
    return value


def selected(path):
    return any(path == t or path.startswith(t + "/") for t in TARGETS)


def safe_relative(path):
    need(isinstance(path, str) and str(PurePosixPath(path)) == path and
         not path.startswith("/") and ".." not in PurePosixPath(path).parts and
         "\x00" not in path and "\\" not in path, "UNSAFE_RELATIVE_PATH")


def link_target(path, target):
    need(isinstance(target, str) and target and not target.startswith("/"), "UNSAFE_LINK")
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(path), target))
    # The sole selected symlink family is the nested tsx esbuild executable.
    need(path.startswith("node_modules/tsx/") and
         resolved.startswith("node_modules/tsx/") and ".vite" not in resolved.split("/"),
         "LINK_OUTSIDE_FIXED_PACKAGE")
    return resolved


def entries_at(root, target, expected, ownership=None):
    """Exact census; hash only manifest-listed files, never unknown content."""
    wanted = {e["path"]: e for e in expected if e["path"] == target or
              e["path"].startswith(target + "/")}
    need(target in wanted, "MISSING_TARGET_BINDING")
    seen, inodes = set(), {}
    def visit(path, relative):
        e = wanted.get(relative)
        need(e is not None, "UNEXPECTED_ENTRY")
        before = path.lstat()
        need(format(stat.S_IMODE(before.st_mode), "04o") == e["mode"], "MODE_DRIFT")
        need(stat.S_ISLNK(before.st_mode) or not before.st_mode & 0o022, "WRITABLE_RUNTIME_ENTRY")
        if ownership is not None:
            own = ownership[relative]
            need([before.st_uid, before.st_gid] == [own["uid"], own["gid"]], "OWNER_DRIFT")
        seen.add(relative)
        inodes[relative] = identity(before)
        if e["type"] == "directory":
            need(stat.S_ISDIR(before.st_mode), "DIRECTORY_TYPE_DRIFT")
            with directory(path) as fd:
                need(identity(os.fstat(fd)) == identity(before), "DIRECTORY_IDENTITY_DRIFT")
                names = sorted(os.listdir(fd))
            expected_names = sorted({p[len(relative) + 1:].split("/")[0] for p in wanted
                                     if p.startswith(relative + "/")})
            need(names == expected_names, "CENSUS_DRIFT")
            for name in names:
                visit(path / name, relative + "/" + name)
        elif e["type"] == "symlink":
            need(stat.S_ISLNK(before.st_mode), "LINK_TYPE_DRIFT")
            target_value = os.readlink(path)
            need(target_value == e["symlink_target"], "LINK_TARGET_DRIFT")
        else:
            need(e["type"] == "file" and stat.S_ISREG(before.st_mode), "FILE_TYPE_DRIFT")
            raw = read(path)
            need(len(raw) == e["size"] and sha(raw) == e["sha256"], "FILE_BYTES_DRIFT")
        need(stable(path.lstat()) == stable(before), "ENTRY_CHANGED_DURING_READ")
    visit(Path(root) / target, target)
    need(seen == set(wanted), "INCOMPLETE_CENSUS")
    return inodes


def stage_archive(archive_path, digest, payload, cohort):
    raw = read(archive_path)
    need(sha(raw) == digest, "ARCHIVE_DRIFT")
    entries = {e["path"]: e for e in cohort["entries"]}
    ownership = cohort["ownership"]
    # Validate the complete archive before creating even its first member.
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
        members = archive.getmembers()
        need(len(members) == len(entries) and len({m.name for m in members}) == len(members),
             "ARCHIVE_CENSUS")
        for member in members:
            safe_relative(member.name)
            need(selected(member.name) and member.name in entries, "UNEXPECTED_ARCHIVE_MEMBER")
            e = entries[member.name]
            need(member.mode == int(e["mode"], 8) and (member.issym() or not member.mode & 0o022),
                 "ARCHIVE_MODE")
            if e["type"] == "directory":
                need(member.isdir(), "ARCHIVE_TYPE")
            elif e["type"] == "symlink":
                need(member.issym() and member.linkname == e["symlink_target"], "ARCHIVE_LINK")
                need(link_target(member.name, member.linkname) in entries, "DANGLING_LINK")
            else:
                need(member.isfile() or member.islnk(), "ARCHIVE_TYPE")
                need(member.size <= MAX_BYTES, "ARCHIVE_SIZE")
                if member.islnk():
                    need(member.linkname == ownership[member.name]["hardlink_to"] and
                         member.linkname in entries, "ARCHIVE_HARDLINK")
                content = archive.extractfile(member).read(MAX_BYTES + 1)
                need(len(content) == e["size"] and sha(content) == e["sha256"], "ARCHIVE_BYTES")
        mkdir(payload)
        # These two containers are staging-only; none is an installation target.
        mkdir(payload / "node_modules", 0o755)
        mkdir(payload / "node_modules/@esbuild", 0o755)
        for member in sorted(members, key=lambda m: (m.name.count("/"), m.name)):
            path = payload / member.name
            if member.isdir():
                mkdir(path, member.mode)
            elif member.isfile():
                exclusive(path, archive.extractfile(member).read(MAX_BYTES + 1), member.mode)
        for member in members:
            path = payload / member.name
            if member.islnk():
                with directory(path.parent) as fd, directory((payload / member.linkname).parent) as src:
                    os.link(Path(member.linkname).name, path.name, src_dir_fd=src,
                            dst_dir_fd=fd, follow_symlinks=False)
                    os.fsync(fd)
            elif member.issym():
                with directory(path.parent) as fd:
                    os.symlink(member.linkname, path.name, dir_fd=fd)
                    os.fsync(fd)
        for target in TARGETS:
            entries_at(payload, target, cohort["entries"], ownership)


class ProcessBoundary:
    """Read-only process census. Stopping/restarting the service is a separate effect."""
    def check(self, root):
        need(sys.platform == "darwin", "OPERATIONAL_PROCESS_SURFACE_UNAVAILABLE")
        result = subprocess.run(["/bin/ps", "-axo", "pid=,command="], capture_output=True,
                                timeout=15, check=False)
        need(result.returncode == 0 and not result.stderr, "PROCESS_CENSUS_UNAVAILABLE")
        for line in result.stdout.decode("utf-8", "strict").splitlines():
            parts = line.strip().split(None, 1)
            if len(parts) == 2 and int(parts[0]) != os.getpid():
                need(str(root) not in parts[1], "RUNTIME_PROCESS_ACTIVE")
        opened = subprocess.run(["/usr/sbin/lsof", "-nP", "-t", "+D", str(root)],
                                capture_output=True, timeout=30, check=False)
        need(opened.returncode in (0, 1) and not opened.stderr, "OPEN_FILE_CENSUS_UNAVAILABLE")
        pids = {int(p) for p in opened.stdout.split()}
        need(not (pids - {os.getpid()}), "RUNTIME_OPEN_FILES_ACTIVE")


class Cohort:
    def __init__(self, manifest, digest, process=None, after_exchange=None):
        self.m = exact_json(manifest, digest)
        need(self.m["schema"] == SCHEMA and set(self.m) == {
            "schema", "operation_id", "root", "root_identity", "controller",
            "materials", "service", "writer_exclusion_reference"}, "MANIFEST_SCHEMA")
        need(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", self.m["operation_id"]), "OPERATION_ID")
        self.root = Path(self.m["root"])
        need(self.root.name == "chat-pro-repository-mcp", "FIXED_PRODUCT_ROOT_REQUIRED")
        self.work = self.root / (".mcp-runtime-cohort-" + self.m["operation_id"])
        self.payload = self.work / "payload"
        self.materials = exact_json(self.m["materials"]["path"], self.m["materials"]["sha256"])
        need(self.materials["schema"] == "mcp-fixed-runtime-materials.v1" and
             self.materials["target_order"] == list(TARGETS) and
             self.materials["fixed_installed_root"] == str(self.root), "FIXED_MATERIAL_BINDING")
        self.old, self.new = (self.materials["cohorts"][role] for role in ("installed", "candidate"))
        for cohort in (self.old, self.new):
            paths = [e["path"] for e in cohort["entries"]]
            need(len(paths) == len(set(paths)), "DUPLICATE_MATERIAL_ENTRY")
            for path in paths:
                safe_relative(path)
                need(selected(path), "NON_TARGET_MATERIAL")
            need(all(t in paths for t in TARGETS), "INCOMPLETE_FIXED_TARGET_SET")
        self.digest = digest
        self.process = process or ProcessBoundary()
        self.after_exchange = after_exchange or (lambda _phase: None)
        self.boundaries()

    def boundaries(self):
        with directory(self.root) as fd:
            need(identity(os.fstat(fd)) == self.m["root_identity"], "ROOT_IDENTITY_DRIFT")
            need(os.fstat(fd).st_uid == os.getuid() and not os.fstat(fd).st_mode & 0o022,
                 "UNSAFE_ROOT_OWNER_MODE")
        controller = Path(self.m["controller"]["path"])
        need(controller == Path(__file__).absolute() and self.root not in controller.parents,
             "RECOVERY_CONTROLLER_MUST_BE_EXTERNAL")
        need(sha(read(controller)) == self.m["controller"]["sha256"], "CONTROLLER_DRIFT")
        need(sha(read(self.m["service"]["plist"])) == self.m["service"]["sha256"], "SERVICE_DRIFT")
        need(bool(self.m["writer_exclusion_reference"]), "WRITER_EXCLUSION_UNBOUND")

    def source(self):
        args = ["git", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c",
                "core.hooksPath=/dev/null", "-c", "core.untrackedCache=false"]
        def run(*tail):
            p = subprocess.run(args + list(tail), cwd=self.root, capture_output=True,
                               timeout=15, check=False)
            need(p.returncode == 0, "SOURCE_READBACK_FAILED")
            return p.stdout.decode().strip()
        need(run("rev-parse", "HEAD") == self.old["head"] and
             run("rev-parse", "HEAD^{tree}") == self.old["tree"] and
             not run("status", "--porcelain=v1", "--untracked-files=no"), "SOURCE_IDENTITY_DRIFT")

    def preserved(self):
        entries = self.materials["unchanged_runtime_entries"]
        # Check the complete non-target runtime census, without reading unknown bytes.
        wanted = {e["path"]: e for e in entries}
        identities = {}
        def visit(path, relative):
            if selected(relative) or relative == "node_modules/.vite":
                return
            need(relative in wanted, "NON_TARGET_CENSUS_DRIFT")
            e = wanted[relative]
            s = path.lstat()
            need(s.st_uid == os.getuid(), "PRESERVED_OWNER_DRIFT")
            identities[relative] = identity(s) + [s.st_nlink]
            need(format(stat.S_IMODE(s.st_mode), "04o") == e["mode"], "PRESERVED_MODE_DRIFT")
            if e["type"] == "directory":
                need(stat.S_ISDIR(s.st_mode), "PRESERVED_TYPE_DRIFT")
                with directory(path) as fd:
                    names = sorted(os.listdir(fd))
                for name in names:
                    visit(path / name, relative + "/" + name)
            elif e["type"] == "symlink":
                need(stat.S_ISLNK(s.st_mode) and os.readlink(path) == e["symlink_target"],
                     "PRESERVED_LINK_DRIFT")
            else:
                need(stat.S_ISREG(s.st_mode), "PRESERVED_TYPE_DRIFT")
                need(s.st_size == e["size"] and sha(read(path)) == e["sha256"], "PRESERVED_BYTES_DRIFT")
        visit(self.root / "node_modules", "node_modules")
        # Ensure missing entries cannot vanish silently.
        for path in wanted:
            need((self.root / path).lstat() is not None, "PRESERVED_MISSING")
        return identities

    def outside(self):
        # Metadata only: no config, credential, task state or private cache bytes.
        # The executor never changes these paths. Nested private-state ownership
        # is additionally bound by the operational writer-exclusion prerequisite.
        result = {}
        with directory(self.root) as fd:
            for name in sorted(os.listdir(fd)):
                if name in ("dist", "node_modules", self.work.name):
                    continue
                result[name] = stable(os.stat(name, dir_fd=fd, follow_symlinks=False))
        cache = self.root / "node_modules/.vite"
        result["node_modules/.vite"] = stable(cache.lstat()) if cache.exists() or cache.is_symlink() else None
        return result

    def location(self, phase, role, target):
        if target == "dist":
            if role == "installed":
                return self.root / "dist" if phase == 0 else self.work / "fence"
            return self.root / "dist" if phase == 10 else self.payload / "dist"
        changed = TARGETS.index(target) < max(0, phase - 1)
        return (self.payload if changed == (role == "installed") else self.root) / target

    def census(self, phase):
        all_ids = {}
        for role, cohort in (("installed", self.old), ("candidate", self.new)):
            ids, locations = {}, {}
            for target in TARGETS:
                actual = self.location(phase, role, target)
                # Adapt the logical target root without following aliases.
                for e in cohort["entries"]:
                    if e["path"] == target or e["path"].startswith(target + "/"):
                        locations[e["path"]] = actual / e["path"][len(target) + 1:] if e["path"] != target else actual
                subset = [dict(e, path="value" + e["path"][len(target):]) for e in cohort["entries"]
                          if e["path"] == target or e["path"].startswith(target + "/")]
                own = {"value" + p[len(target):]: v for p, v in cohort["ownership"].items()
                       if p == target or p.startswith(target + "/")}
                # Use the actual basename as the scanner's logical root.
                subset = [dict(e, path=actual.name + e["path"][5:]) for e in subset]
                own = {actual.name + p[5:]: v for p, v in own.items()}
                part = entries_at(actual.parent, actual.name, subset, own)
                ids.update({target + p[len(actual.name):]: v for p, v in part.items()})
            groups = {}
            for p, own in cohort["ownership"].items():
                if next(e for e in cohort["entries"] if e["path"] == p)["type"] == "file":
                    s = locations[p].lstat()
                    groups.setdefault((s.st_dev, s.st_ino), []).append(p)
                    need(s.st_nlink == own["nlink"], "HARDLINK_COUNT_DRIFT")
                    if own["hardlink_to"]:
                        need(ids[p][:2] == ids[own["hardlink_to"]][:2], "HARDLINK_TOPOLOGY_DRIFT")
            for paths in groups.values():
                need(all(cohort["ownership"][p]["nlink"] == len(paths) for p in paths),
                     "HARDLINK_OUTSIDE_COHORT")
            all_ids[role] = ids
        fence = (self.work / "fence" if phase == 0 else
                 self.payload / "dist" if phase == 10 else self.root / "dist")
        with directory(fence) as fd:
            need(not os.listdir(fd) and stat.S_IMODE(os.fstat(fd).st_mode) == 0o700,
                 "ENTRYPOINT_FENCE_DRIFT")
            all_ids["fence"] = identity(os.fstat(fd))
        return all_ids

    def prepare(self):
        self.boundaries()
        self.source()
        preserved = self.preserved()
        outside = self.outside()
        self.process.check(self.root)
        for target in TARGETS:
            entries_at(self.root, target, self.old["entries"], self.old["ownership"])
        groups = {}
        for e in self.old["entries"]:
            if e["type"] == "file":
                s = (self.root / e["path"]).lstat()
                need(s.st_nlink == self.old["ownership"][e["path"]]["nlink"], "HARDLINK_COUNT_DRIFT")
                groups.setdefault((s.st_dev, s.st_ino), []).append((e["path"], s.st_nlink))
        need(all(all(n == len(group) for _, n in group) for group in groups.values()),
             "HARDLINK_OUTSIDE_COHORT")
        mkdir(self.work)
        exclusive(self.work / "lock", b"")
        mkdir(self.work / "fence")
        artifact = self.materials["artifacts"]["candidate"]
        stage_archive(artifact["path"], artifact["sha256"], self.payload, self.new)
        initial = {"manifest_sha256": self.digest, "identities": self.census(0),
                   "preserved": preserved, "outside": outside,
                   "control_root": identity(self.work.lstat())}
        exclusive(self.work / "initial.json", encoded(initial))
        self.event({"kind": "prepared", "phase": 0, "initial_sha256": sha(encoded(initial))}, [])
        return {"status": "PREPARED_NOT_ACTIVATED", "phase": 0}

    def events(self):
        paths = sorted(self.work.glob("event-*.json"))
        events = []
        for index, path in enumerate(paths):
            need(path.name == f"event-{index:04d}.json", "JOURNAL_GAP")
            value = private_json(path)
            need(value["manifest_sha256"] == self.digest and value["previous"] ==
                 (sha(encoded(events[-1])) if events else None), "JOURNAL_DRIFT")
            events.append(value)
        return events

    def event(self, data, events):
        value = dict(data, manifest_sha256=self.digest,
                     previous=sha(encoded(events[-1])) if events else None)
        exclusive(self.work / f"event-{len(events):04d}.json", encoded(value))
        events.append(value)

    @contextlib.contextmanager
    def locked(self):
        with directory(self.work) as parent:
            s = os.fstat(parent)
            need(s.st_uid == os.getuid() and stat.S_IMODE(s.st_mode) == 0o700, "UNSAFE_CONTROL_ROOT")
            fd = os.open("lock", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                info = os.fstat(fd)
                need(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and
                     info.st_uid == os.getuid(), "UNSAFE_CONTROLLER_LOCK")
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    raise Blocked("CONTROLLER_BUSY") from None
                yield
            finally:
                os.close(fd)

    def inspect(self):
        self.boundaries()
        self.source()
        initial = private_json(self.work / "initial.json")
        need(self.preserved() == initial["preserved"] and self.outside() == initial["outside"],
             "PRESERVATION_IDENTITY_DRIFT")
        need(identity(self.work.lstat()) == initial["control_root"], "CONTROL_ROOT_DRIFT")
        need(initial["manifest_sha256"] == self.digest, "INITIAL_BINDING_DRIFT")
        events = self.events()
        need(events and events[0]["kind"] == "prepared", "PREPARATION_INCOMPLETE")
        need(events[0]["initial_sha256"] == sha(encoded(initial)), "INITIAL_DIGEST_DRIFT")
        allowed = {"lock", "fence", "payload", "initial.json"} | {
            f"event-{index:04d}.json" for index in range(len(events))}
        need(set(os.listdir(self.work)) == allowed, "CONTROL_CENSUS_DRIFT")
        last = events[-1]
        candidates = [last["phase"]] if last["kind"] != "intent" else [last["phase"], last["next"]]
        matches = []
        for phase in candidates:
            try:
                if self.census(phase) == initial["identities"]:
                    matches.append(phase)
            except (Blocked, OSError):
                pass
        need(len(matches) == 1, "UNKNOWN_OR_DRIFTED_EFFECT_NO_REPLAY")
        return matches[0], events

    def run(self, rollback=False):
        with self.locked():
            phase, events = self.inspect()
            if events[-1]["kind"] == "intent":
                need(rollback, "INTERRUPTED_APPLY_REQUIRES_KNOWN_ROLLBACK")
                self.event({"kind": "reconciled", "phase": phase}, events)
            if not rollback:
                need(phase == 0 and len(events) == 1, "APPLY_NOT_FRESH_NO_REPLAY")
            else:
                need(phase > 0, "ROLLBACK_NOT_NEEDED_NO_REPLAY")
            direction = -1 if rollback else 1
            while phase != (0 if rollback else 10):
                self.boundaries()
                self.process.check(self.root)
                need(self.inspect()[0] == phase, "PRE_EXCHANGE_DRIFT")
                nxt = phase + direction
                step = max(phase, nxt)
                if step == 1:
                    left, right = self.root / "dist", self.work / "fence"
                elif step == 10:
                    left, right = self.root / "dist", self.payload / "dist"
                else:
                    target = TARGETS[step - 2]
                    left, right = self.root / target, self.payload / target
                self.event({"kind": "intent", "phase": phase, "next": nxt}, events)
                # Re-opened names must still be the just-inspected objects.
                left_id, right_id = identity(left.lstat()), identity(right.lstat())
                need(self.inspect()[0] == phase, "INTENT_PRESTATE_DRIFT")
                exchange(left, right, left_id, right_id)
                self.after_exchange(nxt)
                need(self.inspect()[0] == nxt, "POST_EXCHANGE_UNKNOWN_EFFECT")
                phase = nxt
                self.event({"kind": "exchanged", "phase": phase}, events)
            self.event({"kind": "rolled_back" if rollback else "candidate_installed", "phase": phase}, events)
            return {"status": "KNOWN_ROLLBACK_VERIFIED" if rollback else
                    "CANDIDATE_INSTALLED_REVIEW_AND_PROMOTION_PENDING", "phase": phase}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "apply", "status", "rollback"))
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--sha256", required=True)
    args = parser.parse_args()
    try:
        operation = Cohort(args.manifest, args.sha256)
        if args.action == "prepare":
            result = operation.prepare()
        elif args.action == "status":
            with operation.locked():
                result = {"status": "EXACT_STATE_READ_BACK", "phase": operation.inspect()[0]}
        else:
            result = operation.run(rollback=args.action == "rollback")
        print(json.dumps(result, sort_keys=True))
    except (Blocked, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        code = str(error) if isinstance(error, Blocked) else "UNCLASSIFIED_LOCAL_STATE_PRESERVE_NO_REPLAY"
        print(json.dumps({"status": "BLOCK", "code": code, "automatic_retry": False,
                          "automatic_rollback": False}, sort_keys=True))
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
