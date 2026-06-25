import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { listU8g2Fonts, listUcgFonts, listU8g2Displays, listUcgDisplays } from "../../src/firmware/graphicsCatalog";

let fw: string;

beforeEach(async () => {
  fw = await fs.mkdtemp(path.join(os.tmpdir(), "nodemcu-gfx-"));
  await fs.mkdir(path.join(fw, "app", "include"), { recursive: true });
  await fs.mkdir(path.join(fw, "app", "u8g2lib", "u8g2", "src", "clib"), { recursive: true });
  await fs.mkdir(path.join(fw, "app", "ucglib", "ucg", "src", "clib"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(fw, { recursive: true, force: true });
});

describe("graphics catalog parsing", () => {
  it("lists u8g2 fonts from the library header, stripping the prefix and de-duping", async () => {
    await fs.writeFile(
      path.join(fw, "app", "u8g2lib", "u8g2", "src", "clib", "u8g2.h"),
      "extern const uint8_t u8g2_font_6x10_tf[];\nextern const uint8_t u8g2_font_6x10_tf[];\nextern const uint8_t u8g2_font_logisoso16_tf[];\n",
    );
    expect(listU8g2Fonts(fw)).toEqual(["font_6x10_tf", "font_logisoso16_tf"]);
  });

  it("lists ucg fonts from the ucg header", async () => {
    await fs.writeFile(
      path.join(fw, "app", "ucglib", "ucg", "src", "clib", "ucg.h"),
      "extern const ucg_fntpgm_uint8_t ucg_font_ncenR14_hr[];\n",
    );
    expect(listUcgFonts(fw)).toEqual(["font_ncenR14_hr"]);
  });

  it("lists u8g2 displays from commented + active table entries and tags the bus", async () => {
    await fs.writeFile(
      path.join(fw, "app", "include", "u8g2_displays.h"),
      [
        "#define U8G2_DISPLAY_TABLE_ENTRY(function, binding)",
        "//  U8G2_DISPLAY_TABLE_ENTRY(u8g2_Setup_sh1106_i2c_128x64_noname_f, sh1106_i2c_128x64_noname) \\",
        "#define U8G2_DISPLAY_TABLE_SPI \\",
        "  U8G2_DISPLAY_TABLE_ENTRY(u8g2_Setup_st7565_64128n_f, st7565_64128n) \\",
      ].join("\n"),
    );
    const list = listU8g2Displays(fw);
    // The macro-definition line (binding="binding") must be filtered out.
    expect(list.find((d) => d.binding === "binding")).toBeUndefined();
    expect(list).toEqual([
      { binding: "sh1106_i2c_128x64_noname", setup: "u8g2_Setup_sh1106_i2c_128x64_noname_f", bus: "i2c" },
      { binding: "st7565_64128n", setup: "u8g2_Setup_st7565_64128n_f", bus: "spi" },
    ]);
  });

  it("lists ucg displays with device + extension args", async () => {
    await fs.writeFile(
      path.join(fw, "app", "include", "ucg_config.h"),
      [
        "#define UCG_DISPLAY_TABLE_ENTRY(binding, device, extension)",
        "  UCG_DISPLAY_TABLE_ENTRY(st7735_18x128x160_hw_spi, ucg_dev_st7735_18x128x160, ucg_ext_st7735_18) \\",
      ].join("\n"),
    );
    expect(listUcgDisplays(fw)).toEqual([
      { binding: "st7735_18x128x160_hw_spi", setup: "ucg_dev_st7735_18x128x160", extension: "ucg_ext_st7735_18" },
    ]);
  });

  it("returns empty arrays when the firmware files are missing", () => {
    const empty = path.join(fw, "nonexistent");
    expect(listU8g2Fonts(empty)).toEqual([]);
    expect(listU8g2Displays(empty)).toEqual([]);
  });
});
