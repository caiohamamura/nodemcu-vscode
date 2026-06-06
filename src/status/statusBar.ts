import { EventEmitter } from "node:events";

export type BuildState = "idle" | "configuring" | "building" | "flashing" | "uploading" | "success" | "error";

export interface StatusUpdate {
  state: BuildState;
  text: string;
  detail?: string;
}

export class StatusEmitter extends EventEmitter {
  private state: BuildState = "idle";
  private text: string = "NodeMCU: idle";
  private detail?: string;

  getState(): BuildState {
    return this.state;
  }

  getText(): string {
    return this.text;
  }

  getDetail(): string | undefined {
    return this.detail;
  }

  update(update: StatusUpdate): void {
    this.state = update.state;
    this.text = update.text;
    this.detail = update.detail;
    this.emit("change", update);
  }
}
