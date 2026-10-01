# 부력과 정수압 모형

Buoyancy Lab은 방향이 고정된 직육면체 한 개와 균질한 액체의 **정적 힘과 위치**를 계산한다. 조건을 바꾸면 새 정적 결과를 바로 표시한다. 낙하·침강·흔들림의 시간이나 속도를 계산하지 않으며, 재생 시간이나 운동 이력도 없다.

물체 질량과 체적은 가상 물체의 독립 입력이다. 평균 밀도는 항상 `질량/체적`에서 나온다. 재질 색이나 유체 밀도 값은 특정 실물 재료·온도의 측정 물성을 뜻하지 않는다. 실제 선박이나 구조물의 안전 판단에 사용하는 모형이 아니다.

## 수조와 좌표

모든 계산은 SI 단위를 쓴다. +Y가 위, 수조 안쪽 바닥이 `y=0`이다. 물체의 수평 위치와 방향은 고정되어 있다.

| 항목 | 값 |
|---|---:|
| 수조 안쪽 폭 × 깊이 × 높이 | 0.50 × 0.35 × 0.50 m |
| 수조 수평 면적 `At` | 0.175 m² |
| 물체가 없을 때의 수면 `H0` | 0.22 m |
| 일정한 액체 체적 `Vf` | 0.0385 m³, 즉 38.5 L |
| 물체 폭 × 깊이 | 0.10 × 0.10 m |
| 물체 수평 면적 `Ab` | 0.01 m² |
| 고정 중력가속도 `g` | 9.80665 m/s² |
| 물체 밑면의 최소 바닥 여유 | 0.015 m |

수면은 고정되어 있지 않다. 같은 양의 액체에서 물체의 잠긴 체적이 커지면 수면이 올라간다. 밀도를 바꾸는 조작은 같은 **체적**의 다른 균질 액체를 선택하는 것이다. 이때 액체의 질량까지 일정하다고 가정하지 않는다.

허용 조건에서 최대 수면은 약 0.231429 m이고 물체 윗면은 수조 높이 아래에 있다. 넘침이나 바닥 접촉을 계산하지 않는다. 액체가 밑면에 들어가지 않는 바닥 밀착 상황을 이 모형의 완전잠김 식으로 해석해서는 안 된다. 공기 부력·표면장력·회전·전복 안정성·점성·유체 혼합·유동 해석도 범위에 포함되지 않는다.

## 저장하는 물리 입력

모형 버전은 `buoyancy-static-1`이다. 실험에는 아래 `config`만 저장한다. 힘·수면·잠김 비율 같은 파생값이나 실행 상태는 추가하지 않는다.

```js
{
  config: {
    bodyMassKg: 0.4,
    bodyVolumeM3: 0.001,
    fluidDensityKgM3: 1000,
    mode: 'equilibrium',
    heldBottomM: 0.06
  }
}
```

| 입력 | 허용 범위 | 의미 |
|---|---|---|
| `bodyMassKg` | 0.1–3 kg | 물체 질량 |
| `bodyVolumeM3` | 0.0005–0.002 m³ | 물체 체적; 높이는 `V/Ab`, 0.05–0.20 m |
| `fluidDensityKgM3` | 800–1200 kg/m³ | 균질 액체의 밀도 |
| `mode` | `equilibrium` 또는 `held` | 자유평형 계산 또는 높이 고정 |
| `heldBottomM` | 0.015–0.28 m | 수조 바닥에서 물체 아랫면까지의 높이 |

`heldBottomM`은 수면 아래 깊이가 아니다. 자유평형 모드에서는 이 값을 기억하지만 현재 물체 위치에는 사용하지 않는다. 모드를 전환하면 서로 다른 구속 조건을 다시 계산한다. 실제로 물체를 놓거나 붙잡는 운동 과정은 아니다.

## 수면과 잠긴 체적

물체 체적을 `V`, 높이를 `h=V/Ab`, 밑면 높이를 `y`, 수면을 `H`, 잠긴 체적을 `Vs`라 하면 다음 두 조건을 동시에 만족한다.

```text
Vs = Ab × clamp(H − y, 0, h)
At × H − Vs = Vf
Hfull = (Vf + V) / At
```

높이를 고정했을 때는 세 경우의 닫힌 해를 사용한다.

1. `y >= H0`: 건조 또는 밑면이 수면에 닿기만 한다. `H=H0`, `Vs=0`.
2. 그 외에 `y+h <= Hfull`: 완전잠김이다. `H=Hfull`, `Vs=V`.
3. 나머지는 부분잠김이다. `H=(Vf−Ab×y)/(At−Ab)`, `Vs=Ab×(H−y)`.

물체가 차지하지 않는 액체 공간의 체적은 항상 `Vf`다. 분기 경계에서 수면과 부력은 연속이다. 계산은 경계의 극소 부동소수점 초과만 보정하며, 큰 침투 오차를 일반적인 제한 함수로 숨기지 않는다.

## 자유평형과 기준 위치

완전히 잠겼을 때 배제되는 액체 질량 `rho×V`와 물체 질량 `m`을 비교한다.

- **가벼운 물체:** `m < rho×V`이면 잠긴 체적은 `Vs=m/rho`다. `H=(Vf+Vs)/At`, `y=H−Vs/Ab`가 방향 고정 모형의 유일한 수면 부유 위치다. `freeEquilibrium='unique'`, `poseKind='equilibrium'`이다.
- **중성부력:** 질량이 같으면 완전히 잠긴 여러 높이에서 평형이다. 관찰 가능한 밑면 구간은 `[0.015, Hfull−h]`다. `freeEquilibrium='continuum'`, `equilibriumBottomM=null`이며, 그림에는 구간 중점을 `poseKind='neutral-reference'`로 표시한다. 유일한 평형 깊이를 뜻하지 않는다.
- **무거운 물체:** `m > rho×V`이면 바닥·외부 지지 없는 자유부유 평형이 없다. `freeEquilibrium='none'`, `equilibriumBottomM=null`이다. 같은 완전잠김 기준 위치를 `poseKind='submerged-reference'`로 그리며, 무게가 부력보다 큰 아래쪽 합력을 남긴다. 기준 위치를 정지 평형이나 계산된 침강 경로로 부르지 않는다.

중성 판정은 `64×Number.EPSILON×max(m,rho×V)` 이하의 질량 차이만 허용한다. 이는 넓은 물리적 중성 구간이 아닌 수치 반올림 수준이다. 원래 질량으로 계산한 힘과 작은 잔차는 그대로 반환하며 0으로 강제하지 않는다.

높이 고정 모드에서도 위 자유평형의 가능 여부는 별도로 제공한다. 현재 물체 위치는 항상 `bodyBottomM`이며, 이 모드에서는 입력한 `heldBottomM`과 정확히 같다.

## 압력과 힘의 부호

수면은 대기에 열려 있다. 압력은 대기압을 뺀 게이지 압력이며 공기 중과 수면에서는 0 Pa다. 높이 `z`의 압력은 다음과 같다.

```text
p(z) = rho × g × max(H − z, 0)
밑면 압력 힘 (+Y) = Ab × p(y)
윗면 압력 힘 (−Y) = −Ab × p(y+h)
부력 Fb = rho × g × Vs
무게 W = m × g
구속 없는 합력 (+Y) = Fb − W
```

부력은 표면 압력 힘을 합친 결과다. 두 표현을 독립적인 힘처럼 다시 더하지 않는다. 깊이에 따른 압력차, 잠긴 체적과 배제된 액체 무게의 관계, 중성부력의 해석은 [OpenStax의 부력 설명](https://openstax.org/books/university-physics-volume-1/pages/14-4-archimedes-principle-and-buoyancy)과 같다. 수조 치수·보존식·계산 코드와 예제는 이 앱의 자체 설계이며 교재 도판이나 문장을 복제하지 않는다.

높이 고정에서는 `holdingForceYN=W−Fb`다. 양수는 위쪽 당김, 음수는 아래쪽 누름이다. 장치는 양방향 강체 구속이며, 액체 안의 연결 표시는 체적 없는 이상적 구속 기호다. 음의 장력으로 누르는 로프를 가정하지 않는다. 자유평형 모드의 고정장치 힘은 항상 0이다. 평형 없는 기준 그림에도 지지력을 몰래 추가하지 않는다.

완전히 잠긴 1 L 물체는 밀도 1000 kg/m³의 액체에서 부력이 9.80665 N이다. 밑면 높이를 0.060 m에서 0.015 m로 내리면 밑면 압력은 1625.102 Pa에서 2066.40125 Pa로, 윗면 압력은 644.437 Pa에서 1085.73625 Pa로 똑같이 증가한다. 압력차와 부력은 변하지 않는다.

## 순수 API와 출력

`src/model.js`는 DOM·Three.js·파일·시간에 의존하지 않는다.

```js
MODEL_VERSION
CONSTANTS_SI
DEFAULT_CONFIG
CONFIG_LIMITS_SI
normalizeConfig(value)
assertConfig(value)
createExperiment(config = DEFAULT_CONFIG)
assertExperiment(value)
getSnapshot(experiment)
samplePressurePa(experiment, heightM)
```

`normalizeConfig`와 `createExperiment`는 라이브 입력에만 기본값·범위 보정을 적용한다. 숫자 문자열을 변환하지 않는다. 파일을 검증할 때는 `assertConfig`/`assertExperiment`를 사용한다. 이들은 정확한 키와 유한 Number, 범위와 enum을 확인하고, 알 수 없는 필드·음의 0·누락·NaN·Infinity를 거부한다. 성공하면 입력을 변경하지 않고 같은 객체를 반환한다. `getSnapshot`과 압력 표본 API도 보정 없이 엄격히 검사한다.

Snapshot의 `config`, 중성 구간 배열, 압력 표본은 모두 원본과 별개다. 입력이 같으면 결과가 같고 숨은 시간이나 누적 상태가 없다. 주요 출력은 다음과 같다.

- 위치: `bodyBottomM`, `bodyTopM`, `bodyHeightM`, `bodyCenterM`, `waterLevelM`. 중심은 모두 +Y 높이인 숫자이며 3D 벡터가 아니다.
- 잠김: `immersion` (`dry`/`partial`/`full`), `displacedVolumeM3`, `submergedHeightM`, `submergedFraction`. `centerOfBuoyancyM`는 잠긴 구간의 중점이며 건조하면 `null`이다.
- 평형: `freeEquilibrium`, `poseKind`, `equilibriumBottomM`, `neutralBottomRangeM`. `null`은 위치가 0이라는 뜻이 아니다.
- 힘: `weightN`은 양의 크기, `buoyancyN`은 위쪽 크기다. `holdingForceYN`, `unrestrainedForceYN`, `netForceYN`, 두 면의 `...ForceYN`은 +Y를 양수로 하는 값이다.
- 압력: `bottomGaugePressurePa`, `topGaugePressurePa`, 밑면부터 윗면까지 균일 높이 9개의 `pressureSamples` (`{heightM,gaugePressurePa}`).
- 보존 확인: `fluidVolumeM3`, `emptyWaterLevelM`, `fluidVolumeResidualM3=At×H−Vs−Vf`, `bottomContact=false`.

`samplePressurePa(experiment,heightM)`는 현재 결과 수면에서 같은 높이의 정수압을 반환한다. 허용 높이는 수조 좌표 0–0.50 m이며 수면보다 높으면 0이다. 점이 물체 내부의 실제 액체라고 주장하는 함수가 아니라 액체 및 물체 경계의 높이별 압력장을 표본화한다.

## 검증 방법

```text
node --test tests/model.test.mjs
```

계산 검사는 수조 높이 구간별 물 단면적 적분과 이분법으로 수면을 독립적으로 구한다. 체적 31개·높이 54개·밀도 3개의 5,022개 고정 조건에서 닫힌 해와 비교하고, 직육면체 여섯 면의 압력 힘 적분을 별도로 더해 부력을 확인한다. 세 실험의 독립 수치값, 건조/부분/완전잠김 경계, 중성 허용오차 양쪽, 위쪽 당김·아래쪽 누름, 평형 없는 그림의 음의 합력, 수조·바닥 여유, 원본과 출력의 분리도 검사한다.

이 검사는 정적 모형의 범위에 관한 것이다. 렌더링·조작·설치·실제 사용자 평가를 대신하지 않는다.
