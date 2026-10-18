"""Run the production mod against the installed native host's no-inference test kit."""
import json
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix="dotbabel-claude-host-") as temporary:
    plugin = pathlib.Path(temporary)
    for child in [".claude-plugin", "hooks", "tests"]:
        (plugin / child).mkdir()
    (plugin / ".claude-plugin/plugin.json").write_text(json.dumps({
        "name": "dotbabel-routing-boundary", "version": "0.1.0",
        "description": "Production MAIN boundary host contract test",
        "author": {"name": "dotbabel"},
    }))
    (plugin / "hooks/hooks.json").write_text(json.dumps({"modules": ["./register.js"]}))
    source = (ROOT / "plugins/dotbabel/src/adaptive-session-routing/claude-mod.mjs").read_text()
    source += """
export function register(on) {
  registerClaudeRouting(on, {
    manual: { model: { source: 'inherited' }, reasoning: { source: 'inherited' } },
    prepare: async () => ({status: 'proposed', changes: {model: 'host-selected', reasoning: 'high'}, diagnostics: []})
  });
}
"""
    (plugin / "hooks/register.js").write_text(source)
    helper = ROOT / "plugins/dotbabel/src/adaptive-session-routing/claude-mod-prepare.mjs"
    (plugin / "hooks/claude-mod-prepare.mjs").write_bytes(helper.read_bytes())
    fixture = ROOT / "plugins/dotbabel/tests/fixtures/adaptive-session-routing/claude-mod/host.test.ts"
    (plugin / "tests/host.test.ts").write_bytes(fixture.read_bytes())
    for operation in ["validate", "test"]:
        result = subprocess.run(["claude", "plugin", operation, str(plugin)], text=True, capture_output=True, timeout=30)
        print(result.stdout + result.stderr)
        if result.returncode:
            raise SystemExit(result.returncode)
print("Installed host protocol passes; no provider execution is proven by this test kit.")
