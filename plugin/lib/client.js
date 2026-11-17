// Browser bundle in the official DSH ModuleLoader format. No dynamic code evaluation.
window.__ModuleLoader__.load({
  id: 'dsh-touch-id',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const operation = 'demo.consume';
    const beginDeadlineMs = 16_000;
    const cancelDeadlineMs = 4_000;
    const inject = ['slots'];
    const errors = {
      forbidden: '当前入口没有模拟权限。',
      busy: '已有模拟请求正在进行，请稍后重试。',
      cancelled: '模拟已取消。',
      timeout: '模拟请求超时，请重试。',
      disposed: '插件已停止，模拟未完成。',
      'operation-changed': '操作已变化，模拟未完成。',
      'unknown-request': '请求已失效，请重试。',
      unexpected: '模拟结果异常，请重试。',
      offline: '连接中断，模拟未完成。'
    };

    function SimulationPage({ send }) {
      const [status, setStatus] = React.useState('点击按钮，测试一次无副作用的 Host 往返。');
      const [busy, setBusy] = React.useState(false);
      const [canCancel, setCanCancel] = React.useState(false);
      const active = React.useRef(null);
      const live = React.useRef(true);

      async function invoke(method, payload, signal) {
        const response = await send('api/touch-id-simulation/' + method, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload), signal
        });
        if (!response.ok) return { ok: false, code: response.status === 403 ? 'forbidden' : 'offline' };
        return response.json();
      }

      function show(request, message) {
        if (live.current && active.current === request) setStatus(message);
      }

      async function confirmCancel(request) {
        if (!request.id) return;
        if (!request.cancelPromise) request.cancelPromise = (async () => {
          const controller = new AbortController();
          const deadline = setTimeout(() => controller.abort(), cancelDeadlineMs);
          try {
            const reply = await invoke('cancel', { id: request.id, operation }, controller.signal);
            return reply?.ok === true && reply.state === 'cancelled';
          } catch {
            return false;
          } finally {
            clearTimeout(deadline);
          }
        })();
        const confirmed = await request.cancelPromise;
        show(request, confirmed ? errors.cancelled : '取消结果未确认，Host 将在超时后结束请求。');
        request.controller.abort();
      }

      React.useEffect(() => {
        live.current = true;
        return () => {
          live.current = false;
          const request = active.current;
          if (!request || request.phase === 'consume') return;
          request.cancelled = true;
          if (request.id) void confirmCancel(request);
        };
      }, []);

      async function cancel() {
        const request = active.current;
        if (!request) return;
        if (request.phase === 'consume') {
          show(request, '模拟结果已提交，正在等待 Host 回执。');
          return;
        }
        if (request.cancelled) return;
        request.cancelled = true;
        setCanCancel(false);
        show(request, '正在取消，等待 Host 确认…');
        // Wait for the Host id if begin is still in flight.
        if (request.id) await confirmCancel(request);
      }

      async function run() {
        if (active.current) return;
        const request = { controller: new AbortController(), beginController: new AbortController(),
          id: null, cancelled: false, phase: 'begin', cancelPromise: null };
        active.current = request;
        setBusy(true);
        setCanCancel(true);
        setStatus('正在请求 Host 执行模拟…');
        try {
          const deadline = setTimeout(() => request.beginController.abort(), beginDeadlineMs);
          let started;
          try {
            started = await invoke('begin', { operation }, request.beginController.signal);
          } finally {
            clearTimeout(deadline);
          }
          if (!started?.ok || typeof started.id !== 'string' || !started.id || started.operation !== operation) {
            throw new Error(started?.code || 'unexpected');
          }
          request.id = started.id;
          if (request.cancelled || !live.current) {
            await confirmCancel(request);
            return;
          }
          request.phase = 'wait';
          const settled = await invoke('wait', { id: request.id, operation }, request.controller.signal);
          if (request.cancelled || !live.current) {
            await confirmCancel(request);
            return;
          }
          if (!settled?.ok || settled.state !== 'ready') throw new Error(settled?.code || 'unexpected');
          request.phase = 'consume';
          setCanCancel(false);
          show(request, '模拟结果已提交，正在等待 Host 回执。');
          const consumed = await invoke('consume', { id: request.id, operation }, request.controller.signal);
          if (!consumed?.ok || consumed.state !== 'consumed' || consumed.id !== request.id
              || consumed.operation !== operation) throw new Error(consumed?.code || 'unexpected');
          show(request, '模拟完成：Host 已消费这次合成结果。');
        } catch (error) {
          if (request.cancelled && request.id) await confirmCancel(request);
          else if (request.cancelled) show(request, '取消结果未确认，Host 将在超时后结束请求。');
          else if (request.phase === 'consume') show(request, '模拟结果未确认，Host 可能已经消费，请勿重复提交。');
          else show(request, errors[error?.message] || errors.offline);
        } finally {
          if (active.current === request) {
            active.current = null;
            if (live.current) { setBusy(false); setCanCancel(false); }
          }
        }
      }

      return h('section', { 'aria-label': '系统验证接入模拟' },
        h('h3', null, '系统验证接入模拟'),
        h('p', null, '仅为合成演示，不调用 Touch ID、系统密码或任何真实认证。'),
        h('p', null, '此入口尚未证明 Desktop 来源，不能用于保护真实操作。'),
        h('button', { type: 'button', onClick: run, disabled: busy }, '开始模拟'), ' ',
        h('button', { type: 'button', onClick: cancel, disabled: !canCancel }, '取消'),
        h('p', { role: 'status', 'aria-live': 'polite' }, status));
    }

    function apply(ctx) {
      const bridge = globalThis.dshTouchId;
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config', key: 'dsh-touch-id',
        inject: () => bridge ? { bridge } : { send: globalThis.fetch.bind(globalThis) }
      }, bridge ? VerificationPage : SimulationPage));
    }

    function VerificationPage({ bridge }) {
      const [policy, setPolicy] = React.useState('system-owner');
      const [status, setStatus] = React.useState('正在检查系统验证是否可用…');
      const [available, setAvailable] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const live = React.useRef(true);
      const running = React.useRef(false);
      React.useEffect(() => {
        live.current = true;
        bridge.capabilities().then(value => {
          if (!live.current) return;
          const ready = value?.ok === true && value.systemOwner?.available === true;
          setAvailable(ready);
          setStatus(ready ? '可以开始身份验证自检。' : '当前桌面验证入口尚未就绪。');
        }).catch(() => { if (live.current) setStatus('暂时无法连接系统验证。'); });
        return () => { live.current = false; void bridge.cancel(); };
      }, []);

      async function verify() {
        if (running.current) return;
        running.current = true;
        setBusy(true);
        setStatus('请在原生确认窗口中核对这次验证。');
        try {
          const value = await bridge.verify(policy);
          if (!live.current) return;
          if (value?.ok === true && value.outcome === 'granted') setStatus('系统验证通过，结果已返回本次自检。');
          else if (value?.code === 'cancelled' || value?.outcome === 'cancelled') setStatus('本次验证已取消。');
          else if (value?.code === 'timeout' || value?.outcome === 'timeout') setStatus('验证已超时，请重新发起。');
          else if (value?.outcome === 'unavailable') setStatus('所选系统验证方式当前不可用。');
          else if (value?.code === 'user-gesture-required') setStatus('请亲自点击按钮开始验证。');
          else if (value?.code === 'result-unconfirmed') setStatus('验证结果未确认，请先核对本次结果，避免重复发起。');
          else setStatus('本次验证未完成，可重新检查后再试。');
        } catch {
          if (live.current) setStatus('连接已中断，本次验证未完成。');
        } finally {
          running.current = false;
          if (live.current) setBusy(false);
        }
      }

      return h('section', { 'aria-label': 'DSH 身份验证' },
        h('h3', null, '验证身份'),
        h('p', null, '发起一次 macOS 系统验证，结果仅用于这次身份验证自检。'),
        h('label', null, '验证方式 ', h('select', {
          value: policy, disabled: busy, onChange: event => setPolicy(event.target.value)
        }, h('option', { value: 'system-owner' }, '系统验证'),
        h('option', { value: 'biometrics-only' }, '仅生物识别'))),
        h('p', null, '调用方为 DSH 身份验证。指纹和系统密码由 macOS 处理。'),
        h('button', { type: 'button', disabled: busy || !available, onClick: verify }, '验证身份'),
        h('button', { type: 'button', disabled: !busy, onClick: async () => {
          setStatus('正在请求取消…');
          const result = await bridge.cancel().catch(() => null);
          if (live.current) setStatus(result?.ok === true ? '本次验证已取消。' : '取消结果待确认，请留意本次验证回执。');
        } }, '取消'),
        h('p', { role: 'status', 'aria-live': 'polite' }, status));
    }
    return { apply, inject };
  }
});
