import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { SettingsCenterController, type CenterRow } from "./ui-controller.ts";
import { renderViewport, viewportLayout } from "./viewport.ts";
import { presentationFrame, presentationRows } from "./presentation.ts";
import type { SettingDescriptor } from "./contracts.ts";

export const BROWSE_HINTS =
  "←/→ tabs · ↑/↓ settings · Enter edit · Tab actions · type search · Esc close";
export const ACTION_HINTS =
  "↑/↓ actions · Enter activate · Tab/Esc settings · ←/→ tabs";
export const EDIT_HINTS =
  "↑/↓ choose · Enter confirm/complete entry · Esc cancel incomplete edit";

/** Custom-UI-owned overlay: no renderer switches, hiding, terminal clears, or separate event loop. */
export class SettingsCenterPanel {
  readonly controller: SettingsCenterController;
  private disposed = false;
  private height = -1;
  private descriptors = new Map<string, SettingDescriptor>();

  constructor(
    rows: readonly CenterRow[],
    private readonly tui: Pick<TUI, "terminal" | "requestRender">,
    private readonly theme: () => Theme,
    done: () => void,
  ) {
    this.descriptors = new Map(
      rows.map((row) => [row.descriptor.id, row.descriptor]),
    );
    this.controller = new SettingsCenterController(presentationRows(rows), {
      bodyHeight: viewportLayout(tui.terminal.rows).bodyHeight,
      onChange: () => {
        if (!this.disposed) tui.requestRender();
      },
      onClose: done,
    });
  }

  setRows(rows: readonly CenterRow[]): void {
    if (!this.disposed) {
      this.descriptors = new Map(
        rows.map((row) => [row.descriptor.id, row.descriptor]),
      );
      this.controller.setRows(presentationRows(rows));
    }
  }

  handleInput(data: string): void {
    if (!this.disposed) this.controller.handleInput(data);
  }

  invalidate(): void {
    if (!this.disposed) this.tui.requestRender();
  }

  render(width: number): string[] {
    const height = this.tui.terminal.rows;
    if (height !== this.height) {
      this.height = height;
      this.controller.resize(viewportLayout(height).bodyHeight);
    }
    const view = this.controller.view();
    const editor = view.editor;
    const theme = this.theme();
    return renderViewport(
      presentationFrame(
        view,
        this.descriptors,
        editor
          ? editor.help
          : view.navigationMode === "actions"
            ? ACTION_HINTS
            : BROWSE_HINTS,
      ),
      width,
      height,
      {
        style: (text, options) => {
          const colored = theme.fg(options.fg ?? "text", text);
          return theme.bg(
            options.bg,
            options.bold ? theme.bold(colored) : colored,
          );
        },
      },
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.dispose();
  }
}
