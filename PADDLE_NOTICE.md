# PaddleOCR models

PaddleOCR — Copyright PaddlePaddle Authors, Apache License 2.0.
Project: https://github.com/PaddlePaddle/PaddleOCR

Official models downloaded 2026-10-04:
- https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx
- https://huggingface.co/PaddlePaddle/en_PP-OCRv5_mobile_rec_onnx

inference.onnx files are redistributed unchanged as paddle_det.onnx and paddle_rec.onnx. The recognition dictionary comes from the official inference.yml. Browser preprocessing, text component extraction and plate assembly are implemented in app.js; this is not the full PaddleOCR.js SDK.
See PADDLE_LICENSE.txt.
