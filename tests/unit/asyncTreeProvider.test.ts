import { describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { AsyncTreeProvider, type TreeItemNode } from "../../src/extension";

function node(id: string): TreeItemNode {
  return {
    id,
    label: id,
    collapsibleState: vscode.TreeItemCollapsibleState.None,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("AsyncTreeProvider", () => {
  it("coalesces overlapping reloads instead of running loaders concurrently", async () => {
    const first = deferred<TreeItemNode[]>();
    const second = deferred<TreeItemNode[]>();
    const calls: number[] = [];
    const provider = new AsyncTreeProvider(async () => {
      calls.push(calls.length + 1);
      return calls.length === 1 ? first.promise : second.promise;
    });

    const firstReload = provider.reload();
    const secondReload = provider.reload();

    expect(calls).toEqual([1]);
    first.resolve([node("first")]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([1, 2]);

    second.resolve([node("second")]);
    await Promise.all([firstReload, secondReload]);

    expect(calls).toEqual([1, 2]);
    expect(provider.getChildren().map((item) => item.id)).toEqual(["second"]);
  });
});
