(function () {
  const DATA_CODEWORDS_L = [0, 19, 34, 55, 80, 108];
  const ECC_CODEWORDS_L = [0, 7, 10, 15, 20, 26];
  const FORMAT_BITS_L_MASK_0 = 0x77c4;

  function utf8Bytes(text) {
    return Array.from(new TextEncoder().encode(text));
  }

  function appendBits(buffer, value, length) {
    for (let i = length - 1; i >= 0; i -= 1) {
      buffer.push((value >>> i) & 1);
    }
  }

  function gfMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i -= 1) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }

  function rsDivisor(degree) {
    const result = Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i += 1) {
      for (let j = 0; j < degree; j += 1) {
        result[j] = gfMultiply(result[j], root);
        if (j + 1 < degree) result[j] ^= result[j + 1];
      }
      root = gfMultiply(root, 2);
    }
    return result;
  }

  function rsRemainder(data, degree) {
    const divisor = rsDivisor(degree);
    const result = Array(degree).fill(0);
    data.forEach((byte) => {
      const factor = byte ^ result.shift();
      result.push(0);
      for (let i = 0; i < degree; i += 1) {
        result[i] ^= gfMultiply(divisor[i], factor);
      }
    });
    return result;
  }

  function chooseVersion(byteLength) {
    for (let version = 1; version <= 5; version += 1) {
      if (byteLength <= DATA_CODEWORDS_L[version] - 2) return version;
    }
    throw new Error("二维码内容过长，请改用批次码扫码或缩短链接");
  }

  function makeDataCodewords(text, version) {
    const bytes = utf8Bytes(text);
    const dataCodewords = DATA_CODEWORDS_L[version];
    const bits = [];
    appendBits(bits, 0x4, 4);
    appendBits(bits, bytes.length, 8);
    bytes.forEach((byte) => appendBits(bits, byte, 8));
    const capacityBits = dataCodewords * 8;
    appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      data.push(bits.slice(i, i + 8).reduce((sum, bit) => (sum << 1) | bit, 0));
    }
    for (let pad = 0xec; data.length < dataCodewords; pad ^= 0xec ^ 0x11) {
      data.push(pad);
    }
    return data;
  }

  function makeMatrix(size) {
    return {
      modules: Array.from({ length: size }, () => Array(size).fill(false)),
      reserved: Array.from({ length: size }, () => Array(size).fill(false)),
    };
  }

  function setFunction(matrix, x, y, dark) {
    if (x < 0 || y < 0 || y >= matrix.modules.length || x >= matrix.modules.length) return;
    matrix.modules[y][x] = Boolean(dark);
    matrix.reserved[y][x] = true;
  }

  function drawFinder(matrix, left, top) {
    for (let y = -1; y <= 7; y += 1) {
      for (let x = -1; x <= 7; x += 1) {
        const xx = left + x;
        const yy = top + y;
        const inPattern = x >= 0 && x <= 6 && y >= 0 && y <= 6;
        const dark = inPattern && (x === 0 || x === 6 || y === 0 || y === 6 || (x >= 2 && x <= 4 && y >= 2 && y <= 4));
        setFunction(matrix, xx, yy, dark);
      }
    }
  }

  function drawAlignment(matrix, center) {
    for (let y = -2; y <= 2; y += 1) {
      for (let x = -2; x <= 2; x += 1) {
        const dark = Math.max(Math.abs(x), Math.abs(y)) === 2 || (x === 0 && y === 0);
        setFunction(matrix, center + x, center + y, dark);
      }
    }
  }

  function reserveFormat(matrix) {
    const size = matrix.modules.length;
    for (let i = 0; i <= 8; i += 1) {
      if (i !== 6) {
        setFunction(matrix, 8, i, false);
        setFunction(matrix, i, 8, false);
      }
    }
    for (let i = 0; i < 8; i += 1) setFunction(matrix, size - 1 - i, 8, false);
    for (let i = 0; i < 7; i += 1) setFunction(matrix, 8, size - 1 - i, false);
  }

  function drawFunctionPatterns(matrix, version) {
    const size = matrix.modules.length;
    drawFinder(matrix, 0, 0);
    drawFinder(matrix, size - 7, 0);
    drawFinder(matrix, 0, size - 7);
    for (let i = 0; i < size; i += 1) {
      if (!matrix.reserved[6][i]) setFunction(matrix, i, 6, i % 2 === 0);
      if (!matrix.reserved[i][6]) setFunction(matrix, 6, i, i % 2 === 0);
    }
    if (version >= 2) drawAlignment(matrix, size - 7);
    reserveFormat(matrix);
    setFunction(matrix, 8, size - 8, true);
  }

  function drawFormatBits(matrix) {
    const size = matrix.modules.length;
    const bits = FORMAT_BITS_L_MASK_0;
    for (let i = 0; i <= 5; i += 1) setFunction(matrix, 8, i, ((bits >>> i) & 1) !== 0);
    setFunction(matrix, 8, 7, ((bits >>> 6) & 1) !== 0);
    setFunction(matrix, 8, 8, ((bits >>> 7) & 1) !== 0);
    setFunction(matrix, 7, 8, ((bits >>> 8) & 1) !== 0);
    for (let i = 9; i < 15; i += 1) setFunction(matrix, 14 - i, 8, ((bits >>> i) & 1) !== 0);
    for (let i = 0; i < 8; i += 1) setFunction(matrix, size - 1 - i, 8, ((bits >>> i) & 1) !== 0);
    for (let i = 8; i < 15; i += 1) setFunction(matrix, 8, size - 15 + i, ((bits >>> i) & 1) !== 0);
    setFunction(matrix, 8, size - 8, true);
  }

  function drawCodewords(matrix, codewords) {
    const size = matrix.modules.length;
    const bits = [];
    codewords.forEach((byte) => appendBits(bits, byte, 8));
    let bitIndex = 0;
    let upward = true;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right -= 1;
      for (let vert = 0; vert < size; vert += 1) {
        const y = upward ? size - 1 - vert : vert;
        for (let j = 0; j < 2; j += 1) {
          const x = right - j;
          if (matrix.reserved[y][x]) continue;
          let dark = bitIndex < bits.length && bits[bitIndex] === 1;
          bitIndex += 1;
          if ((x + y) % 2 === 0) dark = !dark;
          matrix.modules[y][x] = dark;
        }
      }
      upward = !upward;
    }
  }

  function encode(text) {
    const version = chooseVersion(utf8Bytes(text).length);
    const data = makeDataCodewords(text, version);
    const ecc = rsRemainder(data, ECC_CODEWORDS_L[version]);
    const size = version * 4 + 17;
    const matrix = makeMatrix(size);
    drawFunctionPatterns(matrix, version);
    drawCodewords(matrix, data.concat(ecc));
    drawFormatBits(matrix);
    return matrix.modules;
  }

  function renderSvg(text, options = {}) {
    const modules = encode(text);
    const size = modules.length;
    const border = options.border ?? 4;
    const scale = options.scale ?? 8;
    const viewSize = size + border * 2;
    const rects = [];
    modules.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) rects.push(`<rect x="${x + border}" y="${y + border}" width="1" height="1"/>`);
      });
    });
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" width="${viewSize * scale}" height="${viewSize * scale}" role="img" aria-label="二维码"><rect width="100%" height="100%" fill="#fff"/><g fill="#111827">${rects.join("")}</g></svg>`;
  }

  window.QrLite = { renderSvg };
})();
