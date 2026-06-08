import * as vscode from "vscode";
import { MANDATORY_C_MODULES } from "../build/userModulesWriter";

export class IniCompletionItemProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    context: vscode.CompletionContext
  ): vscode.ProviderResult<vscode.CompletionItem[] | vscode.CompletionList> {
    const linePrefix = document.lineAt(position).text.substr(0, position.character);

    // Provide section completions if starting a bracket
    if (linePrefix.endsWith("[")) {
      return ["nodemcu", "c_modules", "lua_modules", "flash", "build"].map((section) => {
        const item = new vscode.CompletionItem(section, vscode.CompletionItemKind.Class);
        item.insertText = section;
        return item;
      });
    }

    // Determine current section by looking backwards
    let currentSection = "";
    for (let i = position.line; i >= 0; i--) {
      const line = document.lineAt(i).text.trim();
      if (line.startsWith("[") && line.endsWith("]")) {
        currentSection = line.substring(1, line.length - 1);
        break;
      }
    }

    // Provide value completions after "="
    if (linePrefix.includes("=")) {
      const keyMatch = linePrefix.match(/^\s*([\w_]+)\s*=/);
      if (keyMatch) {
        const key = keyMatch[1];
        return this.getValueCompletions(currentSection, key);
      }
      return undefined;
    }

    // Provide key completions for specific sections
    const isAtStartOfWord = /^\s*\w*$/.test(linePrefix);
    if (isAtStartOfWord) {
      return this.getKeyCompletions(currentSection);
    }

    return undefined;
  }

  private getValueCompletions(section: string, key: string): vscode.CompletionItem[] {
    const items: string[] = [];

    if (section === "nodemcu") {
      if (key === "lua_version") items.push("51", "53");
      else if (["lua_number_integral", "lua_number_64bits", "parallel", "verbose"].includes(key)) items.push("true", "false");
      else if (key === "flash_mode") items.push("dio", "qio", "dout", "qout");
      else if (key === "flash_freq") items.push("40m", "26m", "20m", "80m");
      else if (key === "flash_size") items.push("512K", "1M", "2M", "4M", "8M", "16M", "detect", "keep");
    } else if (section === "c_modules") {
      items.push("true", "false");
    } else if (section === "build") {
      if (["parallel", "verbose"].includes(key)) items.push("true", "false");
    }

    return items.map((val) => new vscode.CompletionItem(val, vscode.CompletionItemKind.Value));
  }

  private getKeyCompletions(section: string): vscode.CompletionItem[] {
    const keys: string[] = [];

    if (section === "nodemcu") {
      keys.push(
        "lua_version",
        "lua_number_integral",
        "lua_number_64bits",
        "port",
        "baud",
        "upload_baud",
        "flash_mode",
        "flash_freq",
        "flash_size",
        "parallel",
        "verbose",
        "src"
      );
    } else if (section === "c_modules") {
      const knownModules = [
        "adc", "ads1115", "adxl345", "am2320", "apa102", "bit", "bloom", "bmp085",
        "bme280", "bme280_math", "bme680", "coap", "color_utils", "cron", "crypto",
        "dcc", "dht", "encoder", "enduser_setup", "file", "gdbstub", "gpio",
        "gpio_pulse", "hdc1080", "hmc5883l", "http", "hx711", "i2c", "l3g4200d",
        "mcp4725", "mdns", "mqtt", "net", "node", "ow", "pcm", "perf", "pipe",
        "pixbuf", "pwm", "pwm2", "rfswitch", "rotary", "rtcfifo", "rtcmem", "rtctime",
        "si7021", "sigma_delta", "sjson", "sntp", "softuart", "somfy", "spi",
        "struct", "switec", "tcs34725", "tm1829", "tls", "tmr", "tsl2561", "uart",
        "u8g2", "ucg", "websocket", "wiegand", "wifi", "wifi_monitor", "wps",
        "ws2801", "ws2812", "ws2812_effects", "xpt2046"
      ];
      keys.push(...knownModules.filter((m) => !MANDATORY_C_MODULES.has(m)));

    } else if (section === "flash") {
      keys.push("extra_files");
    } else if (section === "build") {
      keys.push("parallel", "verbose");
    }

    return keys.map((k) => new vscode.CompletionItem(k, vscode.CompletionItemKind.Property));
  }
}
