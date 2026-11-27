/* Lazy Three.js rendering for pose trajectories and session-indexed IMU attitude. */
(function (global) {
  'use strict';
  const $ = id => document.getElementById(id);
  let modules;
  Object.assign(global.ViewerStrings, {
    qaSpatial: ['空间轨迹与 IMU 姿态', 'Spatial trajectories and IMU attitude'],
    qaSpatialOpen: ['展开 3D', 'Show 3D'], qaSpatialClose: ['收起 3D', 'Hide 3D'],
    qaSpatialReset: ['复位视角', 'Reset view'], qaSpatialLoading: ['正在加载本地 3D 组件…', 'Loading the offline 3D view…'],
    qaSpatialUnsupported: ['当前浏览器无法初始化 WebGL 2，仍可查看下方覆盖率与断流区间。', 'WebGL 2 could not initialize. Coverage and outage ranges are still available.'],
    qaSpatialNoPose: ['Pose 缺失诊断', 'Missing pose diagnostics'], qaSpatialNoImu: ['当前帧无可用姿态', 'No attitude at this frame'],
    qaSpatialImuHint: ['加速度校正倾角；偏航为相对估计。', 'Acceleration corrects tilt. Yaw is relative.'],
    qaSpatialSegments: ['断流区间 ({n})', 'Outage ranges ({n})'], qaSpatialMore: ['显示更多', 'Show more'],
    qaSpatialGripColor: ['轨迹颜色对应夹爪开合度', 'Trajectory color follows gripper angle']
  });

  async function loadOfflineThree() {
    if (modules) return modules;
    modules = (async () => {
      const script = document.createElement('script');
      script.src = new URL('vendor/three-offline.js', document.baseURI).href;
      const urls = [];
      function moduleUrl(source) {
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
        urls.push(url);
        return url;
      }
      try {
        await new Promise((resolve, reject) => {
          script.onload = resolve;
          script.onerror = () => reject(new Error('Offline Three.js asset is unavailable'));
          document.head.append(script);
        });
        const { core, renderer, controls } = global.RDVThreeModules;
        const coreUrl = moduleUrl(core);
        const rendererUrl = moduleUrl(renderer.replace(/(["'])\.\/three\.core\.min\.js\1/g, JSON.stringify(coreUrl)));
        const controlsUrl = moduleUrl(controls.replace(/from\s*(['"])three\1/g, 'from ' + JSON.stringify(rendererUrl)));
        const [T, { OrbitControls }] = await Promise.all([import(rendererUrl), import(controlsUrl)]);
        return { T, OrbitControls };
      } finally {
        script.remove();
        delete global.RDVThreeModules;
        urls.forEach(url => URL.revokeObjectURL(url));
      }
    })().catch(error => { modules = null; throw error; });
    return modules;
  }

  function sceneView({ T, OrbitControls }, stage, data, onReading) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl2', { alpha: true, antialias: true, powerPreference: 'low-power' });
    if (!context) throw new Error('WebGL 2 unavailable');
    const renderer = new T.WebGLRenderer({ canvas, context, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
    renderer.setClearColor(0, 0);
    renderer.setScissorTest(true);
    let controls;
    let resize;
    let active = false;
    let frameIndex = -1;
    let width = 1;
    let height = 1;
    const poseScene = new T.Scene();
    const imuScene = new T.Scene();
    const camera = new T.PerspectiveCamera(48, 1, .001, 1000);
    const imuCamera = new T.PerspectiveCamera(40, 1, .01, 30);
    const sides = ['left', 'right'];
    const poseExists = sides.some(side => data.poseTrace[side].min !== null);
    const imuExists = data.imu.hasOrientation;
    const turn = new T.Quaternion().setFromAxisAngle(new T.Vector3(1, 0, 0), -Math.PI / 2);
    const position = (values, offset, into) => into.set(values[offset], values[offset + 2], -values[offset + 1]);
    const euler = new T.Euler();
    const color = new T.Color();
    const vec = new T.Vector3();
    const origin = new T.Vector3();
    const rawQuat = new T.Quaternion();
    const box = new T.Box3();
    const markers = {};

    function cleanup() {
      resize?.disconnect();
      controls?.dispose();
      for (const scene of [poseScene, imuScene]) {
        scene.traverse(node => {
          node.geometry?.dispose();
          const materials = Array.isArray(node.material) ? node.material : [node.material];
          for (const item of materials) item?.dispose();
        });
        scene.clear();
      }
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      canvas.width = canvas.height = 0;
    }

    function draw() {
      if (!active || !width || !height) return;
      renderer.setViewport(0, 0, width, height);
      renderer.setScissor(0, 0, width, height);
      renderer.clear();
      if (poseExists) renderer.render(poseScene, camera);
      if (imuExists) {
        const inset = poseExists ? Math.min(170, Math.floor(width * .38), height) : Math.min(width, height);
        const x = poseExists ? width - inset : Math.floor((width - inset) / 2);
        renderer.setViewport(x, 0, inset, inset);
        renderer.setScissor(x, 0, inset, inset);
        renderer.render(imuScene, imuCamera);
      }
    }

    let body;
    let acceleration;
    try {
      if (poseExists) {
        const colors = { left: ['#214787', '#6edcc8'], right: ['#a34822', '#efc455'] };
        for (const side of sides) {
          const trace = data.poseTrace[side];
          if (trace.min === null) continue;
          box.expandByPoint(position(trace.min, 0, vec));
          box.expandByPoint(position(trace.max, 0, vec));
          const vertices = new Float32Array(trace.position.length);
          const vertexColors = new Float32Array(trace.position.length);
          const low = new T.Color(colors[side][0]);
          const high = new T.Color(colors[side][1]);
          for (let i = 0; i < trace.angle.length; i++) {
            position(trace.position, i * 3, vec).toArray(vertices, i * 3);
            const factor = (trace.angle[i] - trace.angleMin) / (trace.angleMax - trace.angleMin);
            color.copy(low).lerp(high, Number.isFinite(factor) ? Math.max(0, Math.min(1, factor)) : .45).toArray(vertexColors, i * 3);
          }
          const g = new T.BufferGeometry();
          g.setAttribute('position', new T.BufferAttribute(vertices, 3));
          g.setAttribute('color', new T.BufferAttribute(vertexColors, 3));
          poseScene.add(new T.LineSegments(g, new T.LineBasicMaterial({ vertexColors: true })));
          markers[side] = new T.Group();
          markers[side].add(
            new T.AxesHelper(.13),
            new T.Mesh(new T.SphereGeometry(.017, 12, 8), new T.MeshBasicMaterial({ color: high }))
          );
          poseScene.add(markers[side]);
        }
        const center = box.getCenter(new T.Vector3());
        const extent = Math.max(.75, box.getSize(new T.Vector3()).length());
        const grid = new T.GridHelper(extent * 2.8, 14, 0x788d7c, 0x728778);
        grid.position.set(center.x, Math.min(0, box.min.y), center.z);
        poseScene.add(grid, new T.AxesHelper(extent * .28));
        camera.position.copy(center).addScaledVector(new T.Vector3(1.2, .85, 1.15), extent);
        controls = new OrbitControls(camera, canvas);
        controls.target.copy(center);
        controls.update();
        controls.saveState();
        controls.addEventListener('change', draw);
      }
      if (imuExists) {
        body = new T.Group();
        body.add(new T.Mesh(new T.BoxGeometry(.95, .34, .66),
          new T.MeshBasicMaterial({ color: 0x76ae86, transparent: true, opacity: .75 })),
        new T.AxesHelper(.95));
        imuScene.add(body);
        imuScene.add(new T.ArrowHelper(new T.Vector3(0, -1, 0), origin, .95, 0x668ccf, .23, .1));
        acceleration = new T.ArrowHelper(new T.Vector3(0, 1, 0), origin, 1.1, 0xd9924c, .22, .1);
        imuScene.add(acceleration);
        imuCamera.position.set(2.45, 1.45, 2.9);
        imuCamera.lookAt(origin);
      }
      stage.prepend(canvas);
      resize = new ResizeObserver(() => {
        width = stage.clientWidth;
        height = stage.clientHeight;
        if (width && height) {
          renderer.setSize(width, height);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          draw();
        }
      });
      resize.observe(stage);
    } catch (error) {
      cleanup();
      throw error;
    }

    function frame(event) {
      if (!active || event.data !== data || event.index < 0 || event.index === frameIndex) return;
      const i = event.index;
      frameIndex = i;
      for (const side of sides) {
        const marker = markers[side];
        if (!marker) continue;
        marker.visible = data.poseValidMask[side][i] === 1;
        if (!marker.visible) continue;
        position(data.pose[side].position, i * 3, marker.position);
        const values = data.pose[side].quaternion;
        if (Number.isFinite(values[i * 4])) marker.quaternion.copy(turn).multiply(rawQuat.fromArray(values, i * 4));
        else marker.quaternion.copy(turn);
      }
      if (body) {
        const imu = data.imu;
        const r = imu.orientation[i * 3], p = imu.orientation[i * 3 + 1], y = imu.orientation[i * 3 + 2];
        const good = Number.isFinite(r);
        body.visible = good;
        acceleration.visible = good && Number.isFinite(imu.accelNorm[i]) && imu.accelNorm[i] > 0;
        if (good) {
          rawQuat.setFromEuler(euler.set(r, p, y, 'ZYX'));
          body.quaternion.copy(turn).multiply(rawQuat);
          if (acceleration.visible) {
            vec.set(imu.ax[i], imu.ay[i], imu.az[i]).normalize().applyQuaternion(body.quaternion);
            acceleration.setDirection(vec);
            acceleration.setLength(Math.min(1.8, imu.accelNorm[i]), .22, .1);
          }
        }
        onReading(good ? [r, p, y] : null);
      }
      draw();
    }

    return {
      dispose: cleanup,
      visible(value) { active = value; if (value) frameIndex = -1; },
      frame,
      reset() { controls?.reset(); }
    };
  }

  global.RobotWorkspace.use(w => {
    const t = w.api.t;
    const root = document.createElement('section');
    root.className = 'panel qa-spatial';
    let instance = null;
    let observer = null;
    let expanded = false;
    let generation = 0;

    function clear() {
      generation++;
      observer?.disconnect();
      observer = null;
      instance?.dispose();
      instance = null;
      root.replaceChildren();
      root.remove();
    }

    function make(tag, text, className) {
      const node = document.createElement(tag);
      if (text) node.textContent = text;
      if (className) node.className = className;
      return node;
    }

    function diagnosis(data, summary) {
      const node = make('div', '', 'qa-spatial-diagnosis');
      if (summary.count.poseMissing) node.append(make('strong', t('qaSpatialNoPose')));
      for (const side of ['left', 'right']) {
        const reading = summary.count[side === 'left' ? 'poseLeft' : 'poseRight'];
        const ranges = data.poseGaps[side];
        const block = make('div', '', 'qa-pose-side');
        block.append(make('b', 'Pose ' + (side === 'left' ? 'L' : 'R') + ' · ' + w.percent(reading / summary.frames)));
        if (ranges.length) {
          const details = make('details');
          details.append(make('summary', t('qaSpatialSegments', { n: ranges.length })));
          const list = make('ul');
          const button = make('button', t('qaSpatialMore'), 'btn');
          let displayed = 0;
          function more() {
            const until = Math.min(displayed + 20, ranges.length);
            for (; displayed < until; displayed++) {
              const range = ranges[displayed];
              const jump = make('button', w.api.timeText(range.start, 3) + ' → ' + w.api.timeText(range.end, 3), 'table-link');
              jump.addEventListener('click', () => w.seekFrame(range.from));
              const row = make('li');
              row.append(jump);
              list.append(row);
            }
            button.hidden = displayed === ranges.length;
          }
          button.addEventListener('click', more);
          more();
          details.append(list, button);
          block.append(details);
        }
        node.append(block);
      }
      return node;
    }

    function render() {
      clear();
      const data = w.dataset;
      const view = w.api.view();
      const summary = w.session?.qa;
      if (!data || !summary || !['analysis', 'linked'].includes(view)) return;
      const linked = view === 'linked';
      const target = $(linked ? 'linkedPoseMount' : 'analysisPoseMount');
      target.append(root);
      const head = make('header');
      const title = make('h3', t('qaSpatial'));
      head.append(title);
      if (linked) {
        const toggle = make('button', t(expanded ? 'qaSpatialClose' : 'qaSpatialOpen'), 'btn');
        toggle.id = 'spatialToggle';
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.addEventListener('click', () => { expanded = !expanded; render(); });
        head.append(toggle);
      }
      root.append(head);
      if (linked && !expanded) return;
      root.append(diagnosis(data, summary));
      if (!summary.count.poseLeft && !summary.count.poseRight && !data.imu.hasOrientation) {
        root.append(make('p', t('qaSpatialNoImu'), 'qa-muted'));
        return;
      }
      const stage = make('div', '', 'qa-spatial-stage');
      stage.id = 'spatialStage';
      const banner = make('p', t('qaSpatialLoading'), 'qa-spatial-state');
      const status = make('span', '', 'qa-spatial-reading');
      const reset = make('button', t('qaSpatialReset'), 'btn');
      reset.id = 'spatialReset';
      reset.disabled = true;
      reset.addEventListener('click', () => instance?.reset());
      if (summary.count.poseLeft || summary.count.poseRight) head.append(reset);
      if (!summary.count.poseLeft && !summary.count.poseRight) stage.classList.add('imu-only');
      if (data.imu.hasOrientation) {
        stage.append(status);
        root.append(stage, make('p', t('qaSpatialImuHint'), 'qa-spatial-foot'));
      } else root.append(stage);
      stage.append(banner);
      if (summary.count.poseLeft || summary.count.poseRight) root.append(make('p', t('qaSpatialGripColor'), 'qa-spatial-foot'));
      const renderId = generation;
      let pending = false;
      let showing = false;
      let failed = false;
      observer = new IntersectionObserver(async ([entry]) => {
        showing = entry.isIntersecting;
        if (instance && renderId === generation) {
          instance.visible(showing);
          if (showing) instance.frame(w.clock.current);
          return;
        }
        if (!showing || pending || failed || renderId !== generation) return;
        pending = true;
        try {
          const three = await loadOfflineThree();
          if (renderId !== generation) return;
          instance = sceneView(three, stage, data, orientation => {
            status.textContent = 'IMU · ' + (orientation ? orientation.map(value => w.number(value * 180 / Math.PI, 1) + '°').join(' / ') : t('qaSpatialNoImu'));
          });
          reset.disabled = false;
          banner.hidden = true;
          stage.dataset.ready = 'true';
          instance.visible(showing);
          if (showing) instance.frame(w.clock.current);
        } catch {
          if (renderId !== generation) return;
          failed = true;
          banner.textContent = t('qaSpatialUnsupported');
          stage.classList.add('spatial-fallback');
        } finally { pending = false; }
      });
      observer.observe(stage);
    }

    w.on('data', render);
    w.on('view', render);
    w.on('locale', render);
    w.on('release', () => { expanded = false; clear(); });
    w.clock.subscribe(frame => instance?.frame(frame));
  });
})(globalThis);