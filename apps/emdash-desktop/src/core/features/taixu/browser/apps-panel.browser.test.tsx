import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import type { AppsStatus } from "../api/apps-contract";
import { AppsPanel } from "./apps-panel";
import "./taixu-shell.css";

const mocks = vi.hoisted(() => ({ apps: vi.fn(), appAction: vi.fn() }));
vi.mock("../api/browser/client", () => ({ getTaixuClient: async () => mocks }));
let root: Root;
let container: HTMLDivElement;
const status: AppsStatus = {
  computer: "Studio",
  apps: ["Flow", "Bloom", "Taste", "Jam", "Wondercraft"].map((name) => ({
    id: name.toLowerCase() as AppsStatus["apps"][number]["id"],
    name,
    detail: `${name} on this computer`,
    supported: true,
    state: "running",
    endpoint: null,
    windowOpen: false,
    blockers: [],
    version: "0.3.0",
  })),
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.apps.mockResolvedValue(structuredClone(status));
  mocks.appAction.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function render() {
  await act(async () =>
    root.render(
      <div className="taixu-apps-page">
        <AppsPanel />
      </div>
    )
  );
  await expect
    .element(page.getByRole("article", { name: "Wondercraft", exact: true }))
    .toBeVisible();
}
it("shows all five services and reserves sharing labels for Flow", async () => {
  await render();
  await expect
    .element(page.getByText("Sharing library", { exact: true }))
    .toBeVisible();
  expect(container.querySelectorAll("article")).toHaveLength(5);
  expect(
    [...container.querySelectorAll("[data-state]")].filter(
      (el) => el.textContent === "Service running"
    )
  ).toHaveLength(4);
  await page
    .getByRole("article", { name: "Wondercraft", exact: true })
    .getByRole("button", { name: "Open on Studio" })
    .click();
  expect(mocks.appAction).toHaveBeenCalledExactlyOnceWith({
    appId: "wondercraft",
    action: "open",
  });
});
it("blocks stopping active work and can start a stopped app", async () => {
  const next = structuredClone(status);
  next.apps[1]!.blockers = ["A render is in progress."];
  next.apps[3]!.state = "stopped";
  mocks.apps.mockResolvedValue(next);
  await render();
  await expect
    .element(
      page
        .getByRole("article", { name: "Bloom", exact: true })
        .getByRole("button", { name: "Stop service" })
    )
    .toBeDisabled();
  await page
    .getByRole("article", { name: "Jam", exact: true })
    .getByRole("button", { name: "Start service" })
    .click();
  expect(mocks.appAction).toHaveBeenCalledExactlyOnceWith({
    appId: "jam",
    action: "start",
  });
});
it("removes stale actions if the selected computer disconnects", async () => {
  await render();
  mocks.apps.mockRejectedValue(Error("Disconnected"));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("App status is unavailable");
  expect(container.querySelectorAll("article")).toHaveLength(0);
  expect(mocks.appAction).not.toHaveBeenCalled();
});
