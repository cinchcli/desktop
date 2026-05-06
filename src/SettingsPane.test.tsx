import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Stub ResizeObserver for jsdom (RetentionSlider uses it)
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

import SettingsPane from "./SettingsPane";

// Track invoke calls for assertion
const invoke = vi.fn();

// Mock @tauri-apps/api/core
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

// Mock @tauri-apps/plugin-global-shortcut
const mockRegister = vi.fn(() => Promise.resolve());
const mockUnregister = vi.fn(() => Promise.resolve());
const mockIsRegistered = vi.fn(() => Promise.resolve(true));

vi.mock("@tauri-apps/plugin-global-shortcut", () => ({
  register: (...args: unknown[]) => mockRegister(...args),
  unregister: (...args: unknown[]) => mockUnregister(...args),
  isRegistered: (...args: unknown[]) => mockIsRegistered(...args),
}));

// Mock @tauri-apps/api/window
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    show: vi.fn(() => Promise.resolve()),
    setFocus: vi.fn(() => Promise.resolve()),
  }),
}));

describe("SettingsPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    // Default mocks: retention config loads, global shortcut loads
    invoke.mockImplementation((cmd: string) => {
      if (cmd === "get_retention_config") {
        return Promise.resolve({ local_days: 30, remote_days: 30 });
      }
      if (cmd === "get_global_shortcut") {
        return Promise.resolve("CmdOrCtrl+Shift+V");
      }
      if (cmd === "set_global_shortcut") {
        return Promise.resolve();
      }
      return Promise.resolve();
    });
  });

  describe("Global shortcut field", () => {
    it("renders the global shortcut input with label", async () => {
      render(<SettingsPane onClose={() => {}} clipCount={0} />);
      const input = await screen.findByLabelText("Global shortcut");
      expect(input).toBeInTheDocument();
      expect(screen.getByText("Show/focus window")).toBeInTheDocument();
    });

    it("displays the shortcut in macOS symbol format", async () => {
      render(<SettingsPane onClose={() => {}} clipCount={0} />);
      const input = await screen.findByLabelText("Global shortcut");
      // CmdOrCtrl+Shift+V should display as command+shift+V symbols
      await waitFor(() => {
        expect(input).toHaveValue("\u2318\u21E7V");
      });
    });

    it("shows error for key press without modifier", async () => {
      render(<SettingsPane onClose={() => {}} clipCount={0} />);
      const input = await screen.findByLabelText("Global shortcut");
      fireEvent.keyDown(input, {
        key: "v",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
      });
      expect(
        await screen.findByText("Shortcut must include a modifier key")
      ).toBeInTheDocument();
    });

    it("ignores modifier-only presses", async () => {
      render(<SettingsPane onClose={() => {}} clipCount={0} />);
      const input = await screen.findByLabelText("Global shortcut");
      fireEvent.keyDown(input, {
        key: "Meta",
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
      });
      // Should not call set_global_shortcut for modifier-only press
      expect(invoke).not.toHaveBeenCalledWith(
        "set_global_shortcut",
        expect.anything()
      );
    });

    it("captures modifier+key combination and persists", async () => {
      render(<SettingsPane onClose={() => {}} clipCount={0} />);
      const input = await screen.findByLabelText("Global shortcut");
      fireEvent.keyDown(input, {
        key: "b",
        metaKey: true,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
      });
      await waitFor(() => {
        expect(invoke).toHaveBeenCalledWith("set_global_shortcut", {
          shortcut: "CmdOrCtrl+Shift+B",
        });
      });
    });

    it("shows error when set_global_shortcut fails", async () => {
      invoke.mockImplementation((cmd: string) => {
        if (cmd === "get_retention_config") {
          return Promise.resolve({ local_days: 30, remote_days: 30 });
        }
        if (cmd === "get_global_shortcut") {
          return Promise.resolve("CmdOrCtrl+Shift+V");
        }
        if (cmd === "set_global_shortcut") {
          return Promise.reject(new Error("invalid"));
        }
        return Promise.resolve();
      });

      render(<SettingsPane onClose={() => {}} clipCount={0} />);
      const input = await screen.findByLabelText("Global shortcut");
      fireEvent.keyDown(input, {
        key: "x",
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
      });
      expect(await screen.findByText("Invalid shortcut")).toBeInTheDocument();
    });
  });

  describe("Clip filters", () => {
    it("does not expose editable filter rules", async () => {
      render(<SettingsPane onClose={() => {}} clipCount={0} />);

      await screen.findByLabelText("Global shortcut");

      expect(screen.queryByText("Clip filters")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Save filter rules" })).not.toBeInTheDocument();
    });
  });
});
