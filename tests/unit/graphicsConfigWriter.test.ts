import { describe, it, expect } from "vitest";
import { defaultConfig, type NodemcuConfig } from "../../src/config/nodemcuIni";
import {
  setU8g2FontsContent,
  setU8g2DisplaysContent,
  setUcgContent,
  activeU8g2Fonts,
  activeU8g2Displays,
  activeUcgFonts,
} from "../../src/build/graphicsConfigWriter";
import type { DisplayCatalogEntry } from "../../src/firmware/graphicsCatalog";

function cfg(overrides: Partial<NodemcuConfig>): NodemcuConfig {
  return { ...defaultConfig(), ...overrides };
}

const U8G2_FONTS = `
#ifndef U8G2_FONT_TABLE_EXTRA
#define U8G2_FONT_TABLE \\
  U8G2_FONT_TABLE_ENTRY(font_6x10_tf) \\
  U8G2_FONT_TABLE_ENTRY(font_unifont_t_symbols) \\

#else
#define U8G2_FONT_TABLE \\
  U8G2_FONT_TABLE_EXTRA
#endif
`;

const U8G2_DISPLAYS = `
#define U8G2_DISPLAY_TABLE_I2C \\
  U8G2_DISPLAY_TABLE_ENTRY(u8g2_Setup_old_i2c_f, old_i2c) \\

#define U8G2_DISPLAY_TABLE_SPI \\
  U8G2_DISPLAY_TABLE_ENTRY(u8g2_Setup_old_spi_f, old_spi) \\
`;

const UCG = `
#define UCG_FONT_TABLE                              \\
    UCG_FONT_TABLE_ENTRY(font_7x13B_tr)             \\
    UCG_FONT_TABLE_ENTRY(font_helvB08_hr)
#undef UCG_FONT_TABLE_ENTRY

#define UCG_DISPLAY_TABLE \\
    UCG_DISPLAY_TABLE_ENTRY(ili9341_18x240x320_hw_spi, ucg_dev_ili9341_18x240x320, ucg_ext_ili9341_18) \\
    UCG_DISPLAY_TABLE_ENTRY(st7735_18x128x160_hw_spi, ucg_dev_st7735_18x128x160, ucg_ext_st7735_18) \\
#undef UCG_DISPLAY_TABLE_ENTRY
`;

describe("graphicsConfigWriter", () => {
  it("reads currently-active u8g2 fonts", () => {
    expect(activeU8g2Fonts(U8G2_FONTS)).toEqual(["font_6x10_tf", "font_unifont_t_symbols"]);
  });

  it("rewrites the u8g2 font table from config and leaves the EXTRA fallback alone", () => {
    const out = setU8g2FontsContent(U8G2_FONTS, cfg({ u8g2_fonts: { font_6x10_tf: true, font_logisoso16_tf: true } }));
    expect(out).toContain("U8G2_FONT_TABLE_ENTRY(font_6x10_tf) \\");
    expect(out).toContain("U8G2_FONT_TABLE_ENTRY(font_logisoso16_tf)");
    expect(out).not.toContain("font_unifont_t_symbols");
    // The #else branch must keep using the EXTRA macro, untouched.
    expect(out).toContain("U8G2_FONT_TABLE_EXTRA");
  });

  it("leaves the header unchanged when the section is empty (preserve firmware default)", () => {
    expect(setU8g2FontsContent(U8G2_FONTS, cfg({ u8g2_fonts: {} }))).toBe(U8G2_FONTS);
  });

  it("routes u8g2 displays into the matching I2C / SPI table by bus", () => {
    const catalog: DisplayCatalogEntry[] = [
      { binding: "ssd1306_i2c_128x64_noname", setup: "u8g2_Setup_ssd1306_i2c_128x64_noname_f", bus: "i2c" },
      { binding: "st7565_64128n", setup: "u8g2_Setup_st7565_64128n_f", bus: "spi" },
    ];
    const out = setU8g2DisplaysContent(
      U8G2_DISPLAYS,
      cfg({ u8g2_displays: { ssd1306_i2c_128x64_noname: true, st7565_64128n: true } }),
      catalog,
    );
    expect(out).toContain("U8G2_DISPLAY_TABLE_ENTRY(u8g2_Setup_ssd1306_i2c_128x64_noname_f, ssd1306_i2c_128x64_noname)");
    expect(out).toContain("U8G2_DISPLAY_TABLE_ENTRY(u8g2_Setup_st7565_64128n_f, st7565_64128n)");
    expect(out).not.toContain("old_i2c");
    expect(out).not.toContain("old_spi");
    expect(activeU8g2Displays(out).sort()).toEqual(["ssd1306_i2c_128x64_noname", "st7565_64128n"]);
  });

  it("rewrites ucg font + display tables without folding the trailing #undef into the macro", () => {
    const catalog: DisplayCatalogEntry[] = [
      { binding: "st7735_18x128x160_hw_spi", setup: "ucg_dev_st7735_18x128x160", extension: "ucg_ext_st7735_18" },
    ];
    const out = setUcgContent(
      UCG,
      cfg({ ucg_fonts: { font_ncenR14_hr: true }, ucg_displays: { st7735_18x128x160_hw_spi: true } }),
      catalog,
    );
    expect(activeUcgFonts(out)).toEqual(["font_ncenR14_hr"]);
    expect(out).not.toContain("font_7x13B_tr");
    expect(out).toContain("UCG_DISPLAY_TABLE_ENTRY(st7735_18x128x160_hw_spi, ucg_dev_st7735_18x128x160, ucg_ext_st7735_18)");
    expect(out).not.toContain("ili9341");
    // The last entry must not carry a trailing backslash, or #undef would be
    // swallowed into the macro definition.
    expect(out).toContain("UCG_FONT_TABLE_ENTRY(font_ncenR14_hr)\n#undef UCG_FONT_TABLE_ENTRY");
  });
});
