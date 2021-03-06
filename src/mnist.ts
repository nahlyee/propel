/*!
   Copyright 2018 Propel http://propel.site/.  All rights reserved.
   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
 */
import { tensor, Tensor } from "./api";
import { assert, assertEqual, fetchArrayBuffer, IS_WEB } from "./util";

export interface Elements {
  images: Tensor;
  labels: Tensor;
}

export function makeHref(fn) {
  if (IS_WEB) {
    return "/static/mnist/" + fn;
  } else {
    // If compiled to JS, this might be in a different directory.
    const path = require("path");
    const dirname = path.resolve(__dirname, "../deps/data/mnist");
    return path.resolve(dirname, fn);
  }
}

export function filenames(split: string): [string, string] {
  if (split === "train") {
    return [
      "deps/data/mnist/train-labels-idx1-ubyte",
      "deps/data/mnist/train-images-idx3-ubyte",
    ];
  } else if (split === "test") {
    return [
      "deps/data/mnist/t10k-labels-idx1-ubyte",
      "deps/data/mnist/t10k-images-idx3-ubyte",
    ];
  } else {
    throw new Error(`Bad split: ${split}`);
  }
}

function littleEndianToBig(val) {
  return ((val & 0x00FF) << 24) |
         ((val & 0xFF00) << 8) |
         ((val >> 8) & 0xFF00) |
         ((val >> 24) & 0x00FF);
}

// TODO Remove once pretty printing lands.
export function inspectImg(t, idx) {
  const img = t.slice([idx, 0, 0], [1, -1, -1]);
  console.log("img");
  const imgData = img.dataSync();
  let s = "";
  for (let j = 0; j < 28 * 28; j++) {
    s += imgData[j].toString() + " ";
    if (j % 28 === 27) s += "\n";
  }
  console.log(s);
}

async function loadFile(href, split: string, isImages: boolean,
                        device: string) {
  const ab = await fetchArrayBuffer(href);
  const i32 = new Int32Array(ab);
  const ui8 = new Uint8Array(ab);

  const magicValue = isImages ? 2051 : 2049;
  const numExamples = split === "train" ? 60000 : 10000;
  let i = 0;
  assertEqual(littleEndianToBig(i32[i++]), magicValue);
  assertEqual(littleEndianToBig(i32[i++]), numExamples);

  let t;
  if (isImages) {
    assertEqual(littleEndianToBig(i32[i++]), 28);
    assertEqual(littleEndianToBig(i32[i++]), 28);
    // TODO Small performance hack here. DL has an expensive cast operation,
    // and because nn_example uses float32 versions of mnist images, we cast
    // the entire dataset here upfront.
    // Ideally casts should be almost free, like they are in TF.
    const tensorData = new Float32Array(ui8.slice(4 * i));
    t = tensor(tensorData, {dtype: "float32", device});
  } else {
    const tensorData = new Int32Array(ui8.slice(4 * i));
    t = tensor(tensorData, {dtype: "int32", device});
  }
  const shape = isImages ? [numExamples, 28, 28] : [numExamples];

  // TODO the copy() below is to work around a bug where reshaping a int32
  // tensor on TF/GPU must be copied to CPU. It should be removed in the limit.
  return t.reshape(shape).copy(device);
}

export async function loadSplit(split: string):
    Promise<{images: Tensor, labels: Tensor}> {
  const [hrefLabels, hrefImages] = filenames(split);
  const imagesPromise = loadFile2(hrefImages);
  const labelsPromise = loadFile2(hrefLabels);
  const [images, labels] = await Promise.all([imagesPromise, labelsPromise]);
  return { images, labels };
}

async function loadFile2(href: string) {
  const ab = await fetchArrayBuffer(href);
  const i32 = new Int32Array(ab);
  const ui8 = new Uint8Array(ab);

  let i = 0;
  const magicValue = littleEndianToBig(i32[i++]);
  let isImages;
  if (magicValue === 2051) {
    isImages = true;
  } else if (magicValue === 2049) {
    isImages = false;
  } else {
    throw Error("Bad magic value.");
  }
  const numExamples = littleEndianToBig(i32[i++]);

  let t;
  if (isImages) {
    assertEqual(littleEndianToBig(i32[i++]), 28);
    assertEqual(littleEndianToBig(i32[i++]), 28);
    const tensorData = new Int32Array(ui8.slice(4 * i));
    t = tensor(tensorData, {dtype: "int32"});
  } else {
    const tensorData = new Int32Array(ui8.slice(4 * i));
    t = tensor(tensorData, {dtype: "int32"});
  }
  const shape = isImages ? [numExamples, 28, 28] : [numExamples];

  return t.reshape(shape);
}

export function load(split: string, batchSize: number, useGPU = true) {
  const [labelFn, imageFn] = filenames(split);
  const device = useGPU ? "GPU:0" : "CPU:0";
  const imagesPromise = loadFile(imageFn, split, true, device);
  const labelsPromise = loadFile(labelFn, split, false, device);

  const ds = {
    idx: 0,
    images: null,
    labels: null,
    loadPromise: Promise.all([imagesPromise, labelsPromise]),
    next: (): Promise<Elements> => {
      return new Promise((resolve, reject) => {
        // Because MNIST is loaded all at once, the async call per batch isn't
        // really async at all - it's just taking a slice. However other
        // datasets will be async. Without the setTimeout, looping on new data
        // will freeze the notebook. A better solution is needed here.
        setTimeout(() => {
          ds.loadPromise.then((_) => {
            if (ds.idx + batchSize >= ds.images.shape[0]) {
              // Wrap around.
              ds.idx = 0;
            }
            assert(ds.images.device === device);
            assert(ds.labels.device === device);

            const imagesBatch = ds.images.slice([ds.idx, 0, 0],
                                                [batchSize, -1, -1]);
            const labelsBatch = ds.labels.slice([ds.idx], [batchSize]);
            ds.idx += batchSize;
            resolve({
              images: imagesBatch,
              labels: labelsBatch,
            });
          });
        }, 0);
      });
    }
  };

  ds.loadPromise.then(([images, labels]) => {
    ds.images = images;
    ds.labels = labels;
  });
  return ds;
}
