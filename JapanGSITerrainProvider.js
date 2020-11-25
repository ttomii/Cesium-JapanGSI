/* global document */
import {
  defaultValue,
  defined,
  throttleRequestByServer,
  Event,
  Credit,
  WebMercatorTilingScheme,
  HeightmapTerrainData,
  TerrainProvider,
  when,
  Resource,
  Request,
} from 'cesium';

const defaultCredit = new Credit('国土地理院');
const GSI_MAX_TERRAIN_LEVEL = 15;

const getBaseUrl = (usePngData/* , url */) => {
  // if(url){
  //     if (!/\/$/.test(url)) {
  //         return `${url }/`;
  //     }

  //     return url;
  // }

  if (usePngData) {
    return 'https://cyberjapandata.gsi.go.jp/xyz/dem_png';
  }

  return 'https://cyberjapandata.gsi.go.jp/xyz/dem';
};

const getCredit = (credit) => {
  const result = defaultValue(credit, defaultCredit);

  if (typeof result === 'string') {
    return new Credit(result);
  }

  return result;
};

export default class {
  /**
     *
     * @param {Object} options
     * @param {boolean} options.usePngData
     * @param {*} options.proxy
     * @param {number} options.heightPower
     * @param {string|Credit} options.credit
     */
  constructor(options = {}) {
    this._usePngData = defaultValue(options.usePngData, false);

    this._url = getBaseUrl(this._usePngData);

    this._proxy = options.proxy;

    this._heightPower = defaultValue(options.heightPower, 1);

    this._tilingScheme = new WebMercatorTilingScheme({
      numberOfLevelZeroTilesX: 2,
    });

    this._heightmapWidth = 32;
    this._demDataWidth = 256;

    this._terrainDataStructure = {
      heightScale: 1,
      heightOffset: 0,
      elementsPerHeight: 1,
      stride: 1,
      elementMultiplier: 256,
    };

    this._levelZeroMaximumGeometricError = TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
      this._tilingScheme.ellipsoid,
      this._heightmapWidth,
      this._tilingScheme.getNumberOfXTilesAtLevel(0),
    );

    this._errorEvent = new Event();

    this._credit = getCredit(options.credit);
  }

  requestTileGeometry(x, y, level, throttleRequests) {
    const usePngData = this._usePngData;
    const orgx = x;
    const orgy = y;
    let shift = 0;
    if (level > GSI_MAX_TERRAIN_LEVEL) {
      shift = level - GSI_MAX_TERRAIN_LEVEL;
      level = GSI_MAX_TERRAIN_LEVEL;
    }

    x >>= shift + 1;
    y >>= shift;
    const shiftx = (orgx % Math.pow(2, shift + 1)) / Math.pow(2, shift + 1);
    const shifty = (orgy % Math.pow(2, shift)) / Math.pow(2, shift);

    let url;
    if (usePngData) {
      url = `${
        this._url + (level == 15 ? '5a' : '')
      }/${level}/${x}/${y}.png`;
    } else {
      url = `${
        this._url + (level == 15 ? '5a' : '')
      }/${level}/${x}/${y}.txt`;
    }

    const proxy = this._proxy;
    if (defined(proxy)) {
      url = proxy.getURL(url);
    }

    let promise;

    throttleRequests = defaultValue(throttleRequests, true);
    if (throttleRequestByServer) { // Patch for > CESIUM1.35
      if (throttleRequests) {
        promise = throttleRequestByServer(url, Resource.fetch);
        if (!defined(promise)) {
          return undefined;
        }
      } else {
        promise = Resource.fetch(url);
      }
    } else {
      promise = Resource.fetch({
        url,
        request: new Request({ throttle: true }),
      });
    }

    const self = this;

    return when(promise, (data) => {
      const heightCSV = [];
      let heights = [];
      if (usePngData) {
        const canvas = document.createElement('canvas');
        canvas.width = '256';
        canvas.height = '256';
        const cContext = canvas.getContext('2d');
        cContext.mozImageSmoothingEnabled = false;
        cContext.webkitImageSmoothingEnabled = false;
        cContext.msImageSmoothingEnabled = false;
        cContext.imageSmoothingEnabled = false;
        cContext.drawImage(data, 0, 0);
        const pixData = cContext.getImageData(0, 0, 256, 256).data;
        let alt;
        for (let y = 0; y < 256; y++) {
          heights = [];
          for (let x = 0; x < 256; x++) {
            const addr = (x + y * 256) * 4;
            const R = pixData[addr];
            const G = pixData[addr + 1];
            const B = pixData[addr + 2];
            if (R == 128 && G == 0 && B == 0) {
              alt = 0;
            } else {
              //                          alt = (R << 16 + G << 8 + B);
              alt = (R * 65536 + G * 256 + B);
              if (alt > 8388608) {
                alt -= 16777216;
              }
              alt *= 0.01;
            }
            heights.push(alt);
          }
          heightCSV.push(heights);
        }
      } else {
        const LF = String.fromCharCode(10);
        const lines = data.split(LF);
        for (let i = 0; i < lines.length; i++) {
          heights = lines[i].split(',');
          for (let j = 0; j < heights.length; j++) {
            if (heights[j] == 'e') { heights[j] = 0; }
          }
          heightCSV[i] = heights;
        }
      }

      const whm = self._heightmapWidth;
      const wim = self._demDataWidth;
      const hmp = new Int16Array(whm * whm);

      for (let y = 0; y < whm; ++y) {
        for (let x = 0; x < whm; ++x) {
          const py = Math.round((y / Math.pow(2, shift) / (whm - 1) + shifty) * (wim - 1));
          const px = Math.round((x / Math.pow(2, shift + 1) / (whm - 1) + shiftx) * (wim - 1));

          hmp[y * whm + x] = Math.round(heightCSV[py][px] * self._heightPower);
        }
      }

      return new HeightmapTerrainData({
        buffer: hmp,
        width: self._heightmapWidth,
        height: self._heightmapWidth,
        structure: self._terrainDataStructure,
        childTileMask: GSI_MAX_TERRAIN_LEVEL,
      });
    });
  }

  getLevelMaximumGeometricError(level) {
    return this._levelZeroMaximumGeometricError / (1 << level);
  }

  hasWaterMas() {
    return !true;
  }

  getTileDataAvailable() {
    return true;
  }

  get errorEvent() {
    return this._errorEvent;
  }

  get credit() {
    return this._credit;
  }

  get tilingScheme() {
    return this._tilingScheme;
  }

  get ready() {
    return true;
  }
}
