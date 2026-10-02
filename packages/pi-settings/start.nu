#!/usr/bin/env nu

# Start the standalone settings center. Valid completed edits autosave.
# Defaults: fullscreen, offline, temporary user configuration, no project trust.
# Temporary settings are left on disk so you can inspect your test edits.
def main [
    --mode (-m): string = "fullscreen" # fullscreen or regular
    --live # Use your normal user configuration instead of a fresh temporary directory
    ...args: string # Extra Pi arguments; precede flags with --
] {
    if $mode not-in ["fullscreen" "regular"] {
        error make {msg: "--mode must be fullscreen or regular"}
    }

    const entrypoint = path self src/index.ts
    let flags = [
        "--offline"
        "--no-session"
        "--no-approve"
        "--no-extensions"
        "--no-skills"
        "--no-prompt-templates"
        "--no-themes"
        "--no-context-files"
        "--no-tools"
        "--extension" $entrypoint
        "--tui-mode" $mode
    ]

    print "Open /pi-settings after Pi starts. Completed valid edits autosave."
    if $live {
        print "Using your normal user configuration: edits will change those files."
        ^pi ...$flags ...$args
        exit $env.LAST_EXIT_CODE
    } else {
        let agent_dir = mktemp --directory --tmpdir pi-settings-test.XXXXXXXX
        print $"Temporary user configuration: ($agent_dir)"
        with-env {PI_CODING_AGENT_DIR: $agent_dir} {
            # Do not capture/pipeline Pi's output: it needs terminal stdin/stdout.
            ^pi ...$flags ...$args
            exit $env.LAST_EXIT_CODE
        }
    }
}
