import { expect, test } from '@playwright/test';
import { patchSurfaceFragment, patchSurfaceVertex } from '../lib/zone-material';

// A real driver must distinguish neutral code 128 from its shallow neighbours on both sides.
// Shader-string assertions alone cannot catch precision or filtering errors in this boundary.
const vertex = `#version 300 es
#define attribute in
#define varying out
#define texture2D texture
` + patchSurfaceVertex(`
  precision highp float;
  attribute vec3 position;
  attribute vec3 normal;
  #include <common>
  void main() {
    vec3 transformed = position;
    #include <begin_vertex>
    gl_Position = vec4(transformed.xy, transformed.z * 0.1, 1.0);
  }
`).replaceAll(/#include <[^>]+>/g, '');

const fragment = `#version 300 es
#define varying in
#define texture2D texture
#define gl_FragColor result
out highp vec4 result;
` + patchSurfaceFragment(`
  precision highp float;
  #include <common>
  void main() {
    #include <clipping_planes_fragment>
    gl_FragColor = vec4(1.0, 0.0, 0.0, 1.0);
  }
`).replaceAll(/#include <[^>]+>/g, '');

test('blank relief leaves the substrate visible while one-code emboss and deboss survive', async ({ page }) => {
  await page.goto('/design/demo');
  const frames = await page.evaluate(({ vertex, fragment }) => {
    const codes = [0, 127, 128, 129, 255, 128];
    const canvas = document.createElement('canvas');
    canvas.width = codes.length * 2;
    canvas.height = 1;
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL 2 is required for the relief regression');

    const shader = (type: number, source: string) => {
      const compiled = gl.createShader(type)!;
      gl.shaderSource(compiled, source);
      gl.compileShader(compiled);
      if (!gl.getShaderParameter(compiled, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(compiled) ?? 'Shader compilation failed');
      }
      return compiled;
    };
    const vs = shader(gl.VERTEX_SHADER, vertex);
    const fs = shader(gl.FRAGMENT_SHADER, fragment);
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? 'Shader link failed');
    }
    gl.useProgram(program);

    const buffers: WebGLBuffer[] = [];
    const attribute = (name: string, size: number, data: number[]) => {
      const buffer = gl.createBuffer()!;
      buffers.push(buffer);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
      const location = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    };
    attribute('position', 3, [-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0]);
    attribute('aZoneUv', 2, [0, 0, 1, 0, 0, 1, 1, 1]);
    gl.vertexAttrib3f(gl.getAttribLocation(program, 'normal'), 0, 0, 1);
    const support = gl.getAttribLocation(program, 'aZoneSupport');

    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // CanvasTexture uses linear filtering; reading texel centres still has to retain both signs.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, codes.length, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array(codes.flatMap((code) => [code, code, code, 255])));
    gl.uniform1i(gl.getUniformLocation(program, 'uZoneHeight'), 0);

    const frames: number[][] = [];
    for (const range of [0.2, 0.75, 1.5]) {
      gl.uniform1f(gl.getUniformLocation(program, 'uZoneHeightRange'), range);
      for (const width of [codes.length, codes.length * 2]) {
        gl.viewport(0, 0, width, 1);
        for (const supported of [1, 0]) {
          gl.vertexAttrib1f(support, supported);
          gl.clearColor(0, 0, 1, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          const pixels = new Uint8Array(width * 4);
          gl.readPixels(0, 0, width, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          frames.push(Array.from(pixels));
        }
      }
    }
    const error = gl.getError();
    for (const buffer of buffers) gl.deleteBuffer(buffer);
    gl.deleteTexture(texture);
    gl.deleteProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    if (error !== gl.NO_ERROR) throw new Error(`WebGL error: ${error}`);
    return frames;
  }, { vertex, fragment });

  const substrate = [0, 0, 255, 255];
  const relief = [255, 0, 0, 255];
  const visible = [relief, relief, substrate, relief, relief, substrate].flat();
  const unsupported = Array.from({ length: 6 }, () => substrate).flat();
  // Twice the viewport width samples quarter-code interpolants at the shallow feathered edges.
  const feathered = [relief, relief, relief, relief, substrate, substrate,
    relief, relief, relief, relief, relief, substrate].flat();
  const unsupportedFeathered = Array.from({ length: 12 }, () => substrate).flat();
  expect(frames).toEqual(Array.from({ length: 3 }, () =>
    [visible, unsupported, feathered, unsupportedFeathered]).flat());
});
