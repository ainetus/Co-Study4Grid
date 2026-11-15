# Probe 'fidelity' — pixels differing between a proxy frame and the settled live SVG at the same view (1439×886, GPU, 2026-11-15)

| Zoom | main: > 16 / > 48 levels | final: > 16 / > 48 levels |
|---|---|---|
| reading (~4 %) | 9.27 % / 2.55 % | 0.41 % / 0.05 % |
| detail (~12 %) | 8.97 % / 3.04 % | 1.71 % / 0.96 % |
| region (~39 %) | 7.91 % / 2.96 % | 5.50 % / 2.34 % |

Intermediate: text drawn but the integer panel height (reading 2.20 % / 0.64 %, detail 3.78 % / 1.40 %, region 6.44 % / 2.48 %);
fractional box, backgrounds / arrows under 1.5 px cut (reading 0.41 % / 0.05 %, detail 1.54 % / 0.82 %, region 3.97 % / 1.89 %).
text_on_proxy_reading_zoom.png: main's proxy frame | this change's | the live diagram, reading zoom.
