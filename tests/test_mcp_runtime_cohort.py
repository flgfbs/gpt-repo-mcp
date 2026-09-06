"""Provider-free production-controller tests; all writable targets are disposable."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / "scripts/mcp_runtime_cohort.py"
if not SOURCE.exists():
    SOURCE = Path(__file__).with_name("mcp_runtime_cohort.py")
SPEC = importlib.util.spec_from_file_location("cohort", SOURCE)
c = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(c)


class Quiet:
    def check(self, _root):
        pass


class Fixture:
    def __init__(self, base, entry_factory=None):
        self.base = base
        self.root = base / "chat-pro-repository-mcp"
        self.root.mkdir(mode=0o700)
        self.new = base / "candidate"
        self.new.mkdir()
        for root, version in ((self.root, "old"), (self.new, "new")):
            for target in c.TARGETS:
                p = root / target
                if target.endswith(".json"):
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_text(version)
                else:
                    p.mkdir(parents=True, exist_ok=True)
                    content = entry_factory(version) if target == "dist" and entry_factory else version
                    (p / ("server.js" if target == "dist" else "package.json")).write_text(content)
            (root / "node_modules/preserved").mkdir()
            (root / "node_modules/preserved/public.js").write_text("public")
            (root / "node_modules/.vite").mkdir()
            (root / "node_modules/.vite/private-cache").write_text("never read")
            if version == "old":
                first = root / c.TARGETS[0] / "esbuild"
                first.write_bytes(b"closed hardlink")
                os.link(first, root / c.TARGETS[1] / "esbuild")
            nested = root / "node_modules/tsx/bin"
            nested.mkdir()
            (nested / "esbuild").write_text(version)
            os.symlink("bin/esbuild", root / "node_modules/tsx/esbuild")
        (self.root / "source.txt").write_text("source unchanged")
        (self.root / "config.local.json").write_text("fixture only; never read by executor")
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        subprocess.run(["git", "add", "source.txt"], cwd=self.root, check=True)
        subprocess.run(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
                        "-c", "commit.gpgsign=false", "commit", "-qm", "Fixture"],
                       cwd=self.root, check=True)
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=self.root).decode().strip()
        tree = subprocess.check_output(["git", "rev-parse", "HEAD^{tree}"], cwd=self.root).decode().strip()
        self.cohorts = {}
        for role, root in (("installed", self.root), ("candidate", self.new)):
            entries, ownership, groups = [], {}, {}
            paths = sorted(p for p in root.rglob("*") if c.selected(p.relative_to(root).as_posix()))
            for p in paths:
                rel, s = p.relative_to(root).as_posix(), p.lstat()
                kind = "symlink" if p.is_symlink() else "directory" if p.is_dir() else "file"
                entries.append({"path": rel, "type": kind, "mode": format(stat.S_IMODE(s.st_mode), "04o"),
                                "sha256": c.sha(p.read_bytes()) if kind == "file" else None,
                                "size": s.st_size if kind == "file" else 0,
                                "symlink_target": os.readlink(p) if kind == "symlink" else None})
                group = groups.setdefault((s.st_dev, s.st_ino), [])
                ownership[rel] = {"uid": s.st_uid, "gid": s.st_gid, "nlink": s.st_nlink,
                                  "hardlink_to": group[0] if group and kind == "file" else None}
                group.append(rel)
            self.cohorts[role] = {"entries": entries, "ownership": ownership, "head": head, "tree": tree}
        preserved = []
        for rel in ("node_modules", "node_modules/@esbuild", "node_modules/preserved",
                    "node_modules/preserved/public.js"):
            p = self.root / rel
            isfile = p.is_file()
            preserved.append({"path": rel, "type": "file" if isfile else "directory",
                              "mode": format(stat.S_IMODE(p.stat().st_mode), "04o"),
                              "size": p.stat().st_size if isfile else 0,
                              "sha256": c.sha(p.read_bytes()) if isfile else None,
                              "symlink_target": None})
        archive = base / "candidate.tar"
        with tarfile.open(archive, "w", format=tarfile.USTAR_FORMAT) as tar:
            for e in self.cohorts["candidate"]["entries"]:
                tar.add(self.new / e["path"], arcname=e["path"], recursive=False)
        self.materials = {"schema": "mcp-fixed-runtime-materials.v1",
                          "target_order": list(c.TARGETS), "fixed_installed_root": str(self.root),
                          "cohorts": self.cohorts, "unchanged_runtime_entries": preserved,
                          "artifacts": {"candidate": {"path": str(archive), "sha256": c.sha(archive.read_bytes())}}}
        self.material_path = base / "materials.json"
        self.material_path.write_bytes(c.encoded(self.materials))
        plist = base / "service.plist"
        plist.write_text("fixture service identity")
        self.manifest_path = base / "manifest.json"
        self.manifest = {"schema": c.SCHEMA, "operation_id": "fixture-only", "root": str(self.root),
                         "root_identity": c.identity(self.root.stat()),
                         "controller": {"path": c.__file__, "sha256": c.sha(Path(c.__file__).read_bytes())},
                         "materials": {"path": str(self.material_path), "sha256": c.sha(self.material_path.read_bytes())},
                         "service": {"plist": str(plist), "sha256": c.sha(plist.read_bytes())},
                         "writer_exclusion_reference": "fixture-exclusive-owner"}
        self.save()

    def save(self):
        self.material_path.write_bytes(c.encoded(self.materials))
        self.manifest["materials"]["sha256"] = c.sha(self.material_path.read_bytes())
        self.manifest_path.write_bytes(c.encoded(self.manifest))
        self.digest = c.sha(self.manifest_path.read_bytes())

    def op(self, hook=None, process=None):
        return c.Cohort(self.manifest_path, self.digest, process=process or Quiet(), after_exchange=hook)


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="mcp-cohort-test-")
        # /var and /tmp may be aliases on macOS; the production controller rejects aliases.
        self.f = Fixture(Path(self.temp.name).resolve())

    def tearDown(self):
        self.temp.cleanup()

    def test_apply_and_exact_rollback_preserve_source_cache_and_hardlinks(self):
        op = self.f.op()
        original = (self.f.root / c.TARGETS[0] / "esbuild").stat().st_ino
        op.prepare()
        self.assertEqual(op.run()["phase"], 10)
        self.assertEqual((self.f.root / "dist/server.js").read_text(), "new")
        self.assertEqual(op.run(True)["status"], "KNOWN_ROLLBACK_VERIFIED")
        self.assertEqual((self.f.root / "dist/server.js").read_text(), "old")
        self.assertEqual((self.f.root / "source.txt").read_text(), "source unchanged")
        self.assertEqual((self.f.root / "node_modules/.vite/private-cache").read_text(), "never read")
        for target in c.TARGETS[:2]:
            info = (self.f.root / target / "esbuild").stat()
            self.assertEqual((info.st_ino, info.st_nlink), (original, 2))

    def test_every_interruption_is_fenced_and_only_known_rollback_is_admitted(self):
        for phase in range(1, 11):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as temp:
                f = Fixture(Path(temp).resolve())
                def interrupt(observed):
                    if observed == phase:
                        raise InterruptedError("synthetic crash after atomic exchange")
                op = f.op(interrupt)
                op.prepare()
                with self.assertRaises(InterruptedError):
                    op.run()
                fresh = f.op()
                self.assertEqual(fresh.inspect()[0], phase)
                if phase < 10:
                    self.assertFalse((f.root / "dist/server.js").exists())
                else:
                    self.assertEqual((f.root / "dist/server.js").read_text(), "new")
                with self.assertRaisesRegex(c.Blocked, "INTERRUPTED_APPLY"):
                    fresh.run()
                self.assertEqual(fresh.run(True)["phase"], 0)

    def test_restart_entrypoint_never_observes_mixed_dependencies(self):
        observed = []
        def restart(phase):
            entry = self.f.root / "dist/server.js"
            if entry.exists():
                versions = {(self.f.root / t / "package.json").read_text() for t in c.TARGETS[:7]}
                self.assertEqual(versions, {entry.read_text()})
                observed.append((phase, entry.read_text()))
            else:
                observed.append((phase, "fenced"))
        op = self.f.op(restart)
        op.prepare()
        op.run()
        op.run(True)
        self.assertEqual(observed[9], (10, "new"))
        self.assertEqual(observed[-1], (0, "old"))
        self.assertTrue(all(v == "fenced" for _, v in observed[:9] + observed[10:-1]))

    def test_target_drift_after_interruption_never_rolls_back(self):
        def interrupt(phase):
            if phase == 3:
                raise InterruptedError()
        op = self.f.op(interrupt)
        op.prepare()
        with self.assertRaises(InterruptedError):
            op.run()
        (self.f.root / c.TARGETS[0] / "package.json").write_text("other writer")
        with self.assertRaisesRegex(c.Blocked, "UNKNOWN_OR_DRIFTED"):
            self.f.op().run(True)
        self.assertFalse((self.f.root / "dist/server.js").exists())

    def test_preserved_drift_blocks_before_exchange(self):
        op = self.f.op()
        op.prepare()
        (self.f.root / "node_modules/preserved/public.js").write_text("changed")
        with self.assertRaisesRegex(c.Blocked, "PRESERVED_BYTES_DRIFT"):
            op.run()
        self.assertEqual((self.f.root / "dist/server.js").read_text(), "old")

    def test_new_unlisted_file_blocks_without_reading_it(self):
        op = self.f.op()
        op.prepare()
        os.symlink("/not-readable", self.f.root / "node_modules/unknown")
        with self.assertRaisesRegex(c.Blocked, "NON_TARGET_CENSUS_DRIFT"):
            op.run()

    def test_external_hardlink_is_rejected(self):
        op = self.f.op()
        os.link(self.f.root / c.TARGETS[0] / "esbuild", self.f.base / "outside")
        with self.assertRaisesRegex(c.Blocked, "HARDLINK_COUNT_DRIFT"):
            op.prepare()

    def test_unsafe_root_symlink_mode_and_identity(self):
        for mutation in ("mode", "identity", "symlink"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as temp:
                f = Fixture(Path(temp).resolve())
                if mutation == "mode":
                    f.root.chmod(0o777)
                elif mutation == "identity":
                    f.manifest["root_identity"][1] += 1
                    f.save()
                else:
                    old = f.root.with_name("moved")
                    f.root.rename(old)
                    os.symlink(old, f.root)
                with self.assertRaises((c.Blocked, OSError)):
                    f.op()

    def test_service_and_controller_drift(self):
        self.f.manifest["controller"]["sha256"] = "0" * 64
        self.f.save()
        with self.assertRaisesRegex(c.Blocked, "CONTROLLER_DRIFT"):
            self.f.op()

    def test_existing_prepare_and_completed_apply_are_not_replayed(self):
        op = self.f.op()
        op.prepare()
        with self.assertRaises(FileExistsError):
            op.prepare()
        op.run()
        with self.assertRaisesRegex(c.Blocked, "APPLY_NOT_FRESH"):
            op.run()

    def test_archive_traversal_blocks_before_member_creation(self):
        artifact = self.f.materials["artifacts"]["candidate"]
        with tarfile.open(artifact["path"], "w") as tar:
            member = tarfile.TarInfo("../escape")
            member.size = 1
            tar.addfile(member, io.BytesIO(b"x"))
        artifact["sha256"] = c.sha(Path(artifact["path"]).read_bytes())
        self.f.save()
        with self.assertRaisesRegex(c.Blocked, "ARCHIVE_CENSUS"):
            self.f.op().prepare()
        self.assertFalse((self.f.base / "escape").exists())

    def test_active_process_blocks_without_stopping_it(self):
        class Busy:
            def check(self, _root):
                raise c.Blocked("RUNTIME_PROCESS_ACTIVE")
        with self.assertRaisesRegex(c.Blocked, "RUNTIME_PROCESS_ACTIVE"):
            self.f.op(process=Busy()).prepare()
        self.assertFalse((self.f.root / ".mcp-runtime-cohort-fixture-only").exists())

    def test_source_drift_blocks(self):
        (self.f.root / "source.txt").write_text("other source")
        with self.assertRaisesRegex(c.Blocked, "SOURCE_IDENTITY_DRIFT"):
            self.f.op().prepare()

    def test_each_rollback_interruption_preserves_recovery(self):
        for phase in range(0, 10):
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as temp:
                f = Fixture(Path(temp).resolve())
                op = f.op()
                op.prepare()
                op.run()
                def interrupt(observed):
                    if observed == phase:
                        raise InterruptedError()
                with self.assertRaises(InterruptedError):
                    f.op(interrupt).run(True)
                fresh = f.op()
                self.assertEqual(fresh.inspect()[0], phase)
                if phase:
                    self.assertFalse((f.root / "dist/server.js").exists())
                    self.assertEqual(fresh.run(True)["phase"], 0)
                else:
                    self.assertEqual((f.root / "dist/server.js").read_text(), "old")
                    with self.assertRaisesRegex(c.Blocked, "ROLLBACK_NOT_NEEDED"):
                        fresh.run(True)

    def test_interruption_before_first_exchange_is_queryable_not_replayed(self):
        op = self.f.op()
        op.prepare()
        with patch.object(c, "exchange", side_effect=InterruptedError()):
            with self.assertRaises(InterruptedError):
                op.run()
        self.assertEqual(op.inspect()[0], 0)
        with self.assertRaisesRegex(c.Blocked, "INTERRUPTED_APPLY"):
            op.run()
        self.assertEqual((self.f.root / "dist/server.js").read_text(), "old")

    def test_process_appearing_after_fence_stops_before_dependency_change(self):
        op = self.f.op()
        op.prepare()
        class Appears:
            calls = 0
            def check(self, _root):
                self.calls += 1
                if self.calls == 2:
                    raise c.Blocked("RUNTIME_PROCESS_ACTIVE")
        with self.assertRaisesRegex(c.Blocked, "RUNTIME_PROCESS_ACTIVE"):
            self.f.op(process=Appears()).run()
        self.assertEqual(op.inspect()[0], 1)
        self.assertFalse((self.f.root / "dist/server.js").exists())
        self.assertEqual((self.f.root / c.TARGETS[0] / "package.json").read_text(), "old")

    def test_unsafe_control_hardlink_and_missing_saved_side(self):
        op = self.f.op()
        op.prepare()
        os.link(op.work / "initial.json", self.f.base / "outside-initial")
        with self.assertRaisesRegex(c.Blocked, "UNSAFE_CONTROL_FILE"):
            op.run()

    def test_missing_saved_side_keeps_fence_closed(self):
        def interrupt(phase):
            if phase == 2:
                raise InterruptedError()
        op = self.f.op(interrupt)
        op.prepare()
        with self.assertRaises(InterruptedError):
            op.run()
        (op.work / "fence").rename(self.f.base / "displaced-prestate")
        with self.assertRaisesRegex(c.Blocked, "CONTROL_CENSUS_DRIFT"):
            self.f.op().run(True)
        self.assertFalse((self.f.root / "dist/server.js").exists())

    def test_fixed_targets_cannot_be_extended(self):
        self.f.materials["target_order"].append("config.local.json")
        self.f.save()
        with self.assertRaisesRegex(c.Blocked, "FIXED_MATERIAL_BINDING"):
            self.f.op()

    def test_unknown_journal_file_blocks(self):
        op = self.f.op()
        op.prepare()
        (op.work / "unknown").write_text("unclassified")
        with self.assertRaisesRegex(c.Blocked, "CONTROL_CENSUS_DRIFT"):
            op.run()

    def test_lock_does_not_get_broken(self):
        op = self.f.op()
        op.prepare()
        with op.locked():
            with self.assertRaisesRegex(c.Blocked, "CONTROLLER_BUSY"):
                self.f.op().run()

    def test_atomic_exchange_rejects_stale_inode(self):
        left, right = self.f.base / "left", self.f.base / "right"
        left.write_text("left")
        right.write_text("right")
        stale = c.identity(left.stat())
        stale[1] += 1
        with self.assertRaisesRegex(c.Blocked, "EXCHANGE_IDENTITY_DRIFT"):
            c.exchange(left, right, stale, c.identity(right.stat()))
        self.assertEqual(left.read_text(), "left")

    def test_real_node_restart_at_every_apply_and_rollback_exchange(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node is required by this repository's test profile")
        def server(version):
            return "const fs=require('fs'); const paths=" + json.dumps(list(c.TARGETS[:7])) + ";\n" + (
                "for(const p of paths){if(fs.readFileSync(p+'/package.json','utf8')!==" +
                json.dumps(version) + ") throw Error('MIXED_COHORT');}\nconsole.log(" + json.dumps(version) + ");\n")
        with tempfile.TemporaryDirectory() as temp:
            f = Fixture(Path(temp).resolve(), entry_factory=server)
            observed = []
            def restart(phase):
                result = subprocess.run([node, str(f.root / "dist/server.js")], cwd=f.root,
                                        capture_output=True, text=True, timeout=10, check=False)
                if phase in (0, 10):
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(result.stdout.strip(), "old" if phase == 0 else "new")
                else:
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("MODULE_NOT_FOUND", result.stderr)
                    self.assertNotIn("MIXED_COHORT", result.stderr)
                observed.append(phase)
            op = f.op(restart)
            op.prepare()
            op.run()
            op.run(True)
            self.assertEqual(len(observed), 20)


if __name__ == "__main__":
    unittest.main()
