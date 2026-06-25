import { describe, it, expect } from "vitest";
import { parseIni, serializeIni, setGraphicsEntry } from "../../src/config/nodemcuIni";

describe("nodemcu.ini graphics sections", () => {
  it("parses font/display sections as booleans", () => {
    const cfg = parseIni([
      "[u8g2_fonts]",
      "font_6x10_tf=true",
      "font_logisoso16_tf=false",
      "[ucg_displays]",
      "ili9341_18x240x320_hw_spi=true",
    ].join("\n"));
    expect(cfg.u8g2_fonts).toEqual({ font_6x10_tf: true, font_logisoso16_tf: false });
    expect(cfg.ucg_displays).toEqual({ ili9341_18x240x320_hw_spi: true });
    expect(cfg.u8g2_displays).toEqual({});
  });

  it("omits empty graphics sections when serializing", () => {
    const cfg = parseIni("[nodemcu]\nport=COM1\n");
    const out = serializeIni(cfg);
    expect(out).not.toContain("[u8g2_fonts]");
    expect(out).not.toContain("[ucg_displays]");
  });

  it("round-trips populated graphics sections", () => {
    const cfg = parseIni("[u8g2_fonts]\nfont_6x10_tf=true\n");
    const reparsed = parseIni(serializeIni(cfg));
    expect(reparsed.u8g2_fonts).toEqual({ font_6x10_tf: true });
  });

  it("seeds firmware defaults when enabling the first font", () => {
    const cfg = parseIni("[nodemcu]\nport=COM1\n");
    const next = setGraphicsEntry(cfg, "u8g2_fonts", "font_logisoso16_tf", true, ["font_6x10_tf", "font_unifont_t_symbols"]);
    expect(next.u8g2_fonts).toEqual({
      font_6x10_tf: true,
      font_unifont_t_symbols: true,
      font_logisoso16_tf: true,
    });
  });

  it("does not re-seed defaults once the section has entries", () => {
    const cfg = parseIni("[u8g2_fonts]\nfont_6x10_tf=true\n");
    const next = setGraphicsEntry(cfg, "u8g2_fonts", "font_ncenB08_tr", true, ["font_unifont_t_symbols"]);
    expect(next.u8g2_fonts).toEqual({ font_6x10_tf: true, font_ncenB08_tr: true });
  });

  it("removes an entry when disabling", () => {
    const cfg = parseIni("[u8g2_fonts]\nfont_6x10_tf=true\nfont_ncenB08_tr=true\n");
    const next = setGraphicsEntry(cfg, "u8g2_fonts", "font_6x10_tf", false);
    expect(next.u8g2_fonts).toEqual({ font_ncenB08_tr: true });
  });
});
