# Light Meter for the Opple Light Master 3 & 4

Web Bluetooth light meter for the Opple Light Master 3 and 4: lux, colour temperature, Duv, tint, CRI (Ra, R1-R14), melanopic lux and circadian stimulus, live in the browser. Log readings, export CSV.

**Use it:** https://sundaylight.cc/pages/light-meter

Built by [Sunday Light](https://sundaylight.cc). Not affiliated with Opple. MIT licence.

## Using it

1. Chrome or Edge (desktop or Android). Safari and Firefox lack Web Bluetooth; on iPhone/iPad use [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055).
2. Wake the meter and close the Opple app - the meter accepts one connection at a time.
3. **Connect light meter** and pick it: a Light Master 4 appears as `SigMesh`, a Light Master 3 as `LightMaster`.
4. **Log reading** averages eight samples and keeps the result; **Download CSV** exports everything including R1-R14.

| Reading | Meaning |
| --- | --- |
| CCT (K) | Correlated colour temperature (McCamy) |
| Lux | Illuminance at the sensor |
| Duv | Distance from the black-body line: negative = magenta, positive = green |
| Tint | The same on a camera-style scale (Adobe DNG) |
| CRI Ra, R1-R14 | Colour rendering; R9 is saturated red |
| EML | Equivalent melanopic lux |
| CS | Circadian stimulus (Light Master 4 only) |

### Troubleshooting

- The chooser only lists Light Masters. If yours advertises under another name, open **Trouble connecting?** under the connect button and use **Not listed? Show all devices**.
- **Meter stuck? Force disconnect** (same panel) drops any link this page holds and checks whether the meter is advertising. Links held by another tab, the Opple app, or the meter itself can only be cleared there: quit the browser fully, quit the app, restart the meter.
- **Diagnostics** logs every connection step with timings and errors; *Copy log* for bug reports.

## How the numbers are calculated

Each meter reports raw counts per band plus a per-unit calibration vector (`kSensor`), read on connect and applied before any colour maths.

- **Light Master 3**: six bands (450/500/550/570/600/650 nm), source-type classification and Opple's 3x7 tristimulus matrices (from [open-light-master](https://github.com/OlliV/open-light-master)); CRI from a cubic-spline SPD (CIE 13.3); EML from Opple's band fit. Checked against an independent Python implementation to 1e-9.
- **Light Master 4**: eight AS7341 bands (415-680 nm) plus clear. XYZ from the official app's 3x8 matrix (`LightmasterIVCoeff_20231115`), CRI/EML/CS from the app's polynomial model, both extracted by [opple-bridge](https://github.com/gabrielebaudo/opple-bridge). Reproduces the app: 4239 K / Ra 96.5 / R9 52.4 vs 4236 / 96.5 / 52.2 on a real probe.
- Shared: CIE 1931 xy, 1960 uv, McCamy CCT, Ohno Duv (ANSI C78.377), DNG tint, CIE 13.3 CRI.

CRI from six or eight bands is an estimate, not a spectroradiometer result.

## Development

```bash
npm test          # maths and protocol tests
npm run build     # regenerates dist/ (committed; CI checks it)
npm run serve     # http://localhost:8080/?debug=1
```

| File | What |
| --- | --- |
| `src/protocol.js` | UART framing, fragment reassembly, LM3/LM4 payload parsing |
| `src/meter.js` | Web Bluetooth session: connect, calibration, polling, reconnect, diagnostics |
| `src/colour.js` | Chromaticity, CCT, Duv, tint, spline SPD, CRI, battery |
| `src/lm3.js`, `src/lm4.js` | Per-meter pipelines |
| `src/cie-data.js`, `src/lm4-model-data.js` | Generated data tables |
| `src/app.js`, `src/style.css` | The page |
| `scripts/build.mjs` | Inlines everything into `dist/index.html` and the Shopify section `dist/sunday-light-meter.liquid` |

### Protocol

Nordic UART service `6e400001-b5a3-f393-e0a9-e50e24dcca9e`; commands are written to the notify characteristic `…0003` and answered on it. Message = 11-byte header `[0, 0x13, 0, 0, seq, 0, bodyLen, 0, 0, opHi, opLo]` + body, in fragments whose first byte is `0x00` single / `0x80` first / `0xA0|i` middle / `0xC0|i` last. Opcodes: `0x0A00` measure → `0x0A01`; `0x0A04` calibration → `0x0A05`. Measurement payload: LM3 `[skip][6 x u16 BE][battery mV u16][temp]`; LM4 `[skip][9 x u16 BE, clear last][temp x10 u16][battery raw u16]` - the length tells them apart. Calibration: `float32 LE` from payload byte 1, seven (LM3) or nine (LM4). Neither meter advertises the service UUID; match on name (`SigMesh`, `LightMaster`), both carry Opple manufacturer data `0x0539`.

## Credits

- [OlliV/open-light-master](https://github.com/OlliV/open-light-master) - reverse-engineered the Light Master 3 protocol and its colour maths; the LM3 pipeline here follows it.
- [gabrielebaudo/opple-bridge](https://github.com/gabrielebaudo/opple-bridge) - Light Master 4 payload layouts and the official app's colour coefficients; the LM4 pipeline here uses them.
- [Geomaniac15/tag-tester](https://github.com/Geomaniac15/tag-tester) - Light Master 4 protocol notes.
- Colour science: McCamy (CCT), Ohno 2014 / ANSI C78.377 (Duv), CIE 13.3-1995 (CRI), Adobe DNG (tint).

Not affiliated with Opple. Opple and Light Master are trademarks of their owner.
