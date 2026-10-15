# Third-Party Notices

This project uses the following open-source software:

- [Mediabunny](https://github.com/Vanilagy/mediabunny), licensed under the Mozilla Public License 2.0.
- [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm), licensed under the MIT License.
- [JSZip](https://github.com/Stuk/jszip), licensed under the MIT License or GPLv3.
- [Transformers.js](https://github.com/huggingface/transformers.js), Apache License 2.0, and [ONNX Runtime](https://github.com/microsoft/onnxruntime), MIT License, run speech models locally.
- [Silero VAD](https://github.com/snakers4/silero-vad), MIT License. The bundled `src/assets/silero-vad.onnx` is the official model from commit `1e261b036686cd0017d500ee96acd1c4ba572a9d`, path `src/silero_vad/data/silero_vad.onnx`. SHA-256: `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3`. Its original license is included at `src/assets/silero-vad-LICENSE` and in the built assets.

The corresponding package versions are recorded in `package-lock.json`.
