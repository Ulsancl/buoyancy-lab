import * as THREE from 'three';

const opticalVertex = /* glsl */`
  varying vec3 worldPosition;
  varying vec3 worldNormal;

  void main() {
    worldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
    worldNormal = mat3(modelMatrix) * normal;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const opticalFunctions = /* glsl */`
  varying vec3 worldPosition;
  varying vec3 worldNormal;

  // Two large studio panels in fixed world directions, reflected by the surface.
  float reflectedPanels(vec3 ray) {
    float upper = smoothstep(0.75, 0.91, ray.y) * (1.0 - smoothstep(0.11, 0.30, abs(ray.x + 0.20)));
    float side = smoothstep(0.12, 0.31, abs(ray.y)) * (1.0 - smoothstep(0.10, 0.21, abs(ray.x + 0.62)));
    return max(upper, side * 0.63);
  }
`;

const opticalMain = /* glsl */`
  void main() {
    vec3 normal = normalize(worldNormal) * (gl_FrontFacing ? 1.0 : -1.0);
    vec3 eye = normalize(cameraPosition - worldPosition);
    float fresnel = pow(1.0 - clamp(dot(normal, eye), 0.0, 1.0), 4.0);
    vec4 surface = opticalSurface(normal, eye, fresnel);
    gl_FragColor = surface;
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

function opticalMaterial(fragment, uniforms = {}) {
  return new THREE.ShaderMaterial({
    uniforms, vertexShader: opticalVertex, fragmentShader: `${opticalFunctions}\n${fragment}\n${opticalMain}`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true,
  });
}

export function acrylicMaterial(height) {
  return opticalMaterial(/* glsl */`
    uniform float tankHeight;

    vec4 opticalSurface(vec3 normal, vec3 eye, float fresnel) {
      float panel = reflectedPanels(reflect(-eye, normal));
      // The narrow faces of the sheets transmit less light than the broad faces.
      float edge = 1.0 - step(0.004, min(abs(worldPosition.y), abs(worldPosition.y - tankHeight)));
      vec3 tint = mix(vec3(0.32, 0.67, 0.65), vec3(0.92, 1.0, 0.99), panel);
      float opacity = 0.038 + 0.19 * fresnel + 0.25 * panel + 0.11 * edge;
      return vec4(tint, opacity * (gl_FrontFacing ? 1.0 : 0.45));
    }
  `, { tankHeight: { value: height } });
}

export function waterMaterial({ width, depth, bodyWidth, bodyDepth }) {
  return opticalMaterial(/* glsl */`
    uniform float elevation;
    uniform vec2 tankHalfSize;
    uniform vec2 bodyHalfSize;
    uniform bool cutsSurface;

    vec4 opticalSurface(vec3 normal, vec3 eye, float fresnel) {
      if (abs(worldNormal.y) > 0.5 && abs(worldPosition.y - elevation) < 0.00002) {
        vec2 p = worldPosition.xz;
        // Optical variation only. The visible surface and its cavity stay planar.
        vec2 slope = 0.014 * vec2(sin(48.0 * p.x + 31.0 * p.y), cos(28.0 * p.x - 53.0 * p.y));
        float panel = reflectedPanels(reflect(-eye, normalize(normal + vec3(slope.x, 0.0, slope.y))));
        vec2 tankGap = tankHalfSize - abs(p);
        vec2 bodyGap = max(abs(p) - bodyHalfSize, 0.0);
        float contact = min(tankGap.x, tankGap.y);
        if (cutsSurface) contact = min(contact, length(bodyGap));
        float meniscus = 1.0 - smoothstep(0.0004, 0.0048, contact);
        vec3 tint = mix(vec3(0.032, 0.43, 0.44), vec3(0.76, 0.95, 0.93), panel * 0.86 + meniscus * 0.14);
        return vec4(tint, 0.20 + 0.19 * fresnel + 0.25 * panel + 0.24 * meniscus);
      }
      float depth = clamp((elevation - worldPosition.y) / 0.45, 0.0, 1.0);
      vec3 tint = mix(vec3(0.052, 0.43, 0.44), vec3(0.012, 0.21, 0.29), depth);
      return vec4(tint, (0.055 + 0.12 * depth + 0.09 * fresnel) * (gl_FrontFacing ? 1.0 : 0.46));
    }
  `, {
    elevation: { value: 0 },
    tankHalfSize: { value: new THREE.Vector2(width / 2, depth / 2) },
    bodyHalfSize: { value: new THREE.Vector2(bodyWidth / 2, bodyDepth / 2) },
    cutsSurface: { value: false },
  });
}

export function brushedFinishTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  let seed = 89;
  const noise = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let y = 0; y < canvas.height; y++) {
    const grain = Math.round(173 + 82 * noise());
    context.fillStyle = `rgb(${grain},${grain},${grain})`;
    context.fillRect(0, y, canvas.width, 1);
    context.fillStyle = '#fff4';
    context.fillRect(noise() * canvas.width, y, 28 + noise() * 140, 1);
  }
  return new THREE.CanvasTexture(canvas);
}

export function rulerTexture(maxCm) {
  const canvas = document.createElement('canvas');
  canvas.width = 144;
  canvas.height = 2048;
  const context = canvas.getContext('2d');
  const yAt = cm => canvas.height * (maxCm + 2.4 - cm) / (maxCm + 3.4);
  context.fillStyle = '#eef2e9';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.textAlign = 'right';
  context.textBaseline = 'middle';
  context.font = '600 38px "Segoe UI", sans-serif';
  context.fillStyle = '#167477';
  context.fillText('cm', 125, yAt(maxCm + 1.35));
  for (let cm = 0; cm <= maxCm; cm++) {
    const major = cm % 5 === 0, y = yAt(cm);
    context.fillStyle = major ? '#294c4d' : '#819e97';
    context.fillRect(9, y, major ? 54 : 25, major ? 4 : 2);
    if (major) context.fillText(String(cm), 125, y);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
