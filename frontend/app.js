const { createApp } = Vue;

createApp({
  data() {
    return {
      proxyHost: window.location.hostname,
      token: localStorage.getItem('proxy-manager-token') || '',
      password: '',
      proxies: [],
      form: { input: '' },
      addModalOpen: false,
      loginLoading: false,
      listLoading: false,
      addLoading: false,
      deleteLoading: false,
      testing: {},
      toggling: {},
      results: {},
      editingName: null,
      nameDraft: '',
      savingName: {},
      deleteTarget: null,
      versionInfo: null,
      versionLoading: false,
      updateConfirmOpen: false,
      updateLoading: false,
      updateTargetVersion: null,
      updatePollTimer: null,
      updatePollStartedAt: 0,
      notices: []
    };
  },
  computed: {
    runningCount() {
      return this.proxies.filter((proxy) => proxy.is_running).length;
    }
  },
  mounted() {
    if (this.token) {
      this.loadProxies();
      this.loadVersion();
    }
  },
  beforeUnmount() {
    this.stopUpdatePolling();
  },
  methods: {
    async request(path, options = {}) {
      const headers = { ...(options.headers || {}) };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      if (options.body) headers['Content-Type'] = 'application/json';
      const response = await fetch(path, { ...options, headers });
      if (response.status === 401 && path !== '/api/login') {
        this.logout('登录已过期，请重新登录');
        throw new Error('登录已过期');
      }
      if (response.status === 204) return null;
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
      return payload;
    },
    async login() {
      this.loginLoading = true;
      try {
        const data = await this.request('/api/login', { method: 'POST', body: JSON.stringify({ password: this.password }) });
        this.token = data.token;
        localStorage.setItem('proxy-manager-token', data.token);
        this.password = '';
        await Promise.all([this.loadProxies(), this.loadVersion()]);
        this.notify('登录成功', 'success');
      } catch (error) {
        this.notify(error.message, 'error');
      } finally {
        this.loginLoading = false;
      }
    },
    logout(message) {
      this.stopUpdatePolling();
      this.token = '';
      this.proxies = [];
      this.versionInfo = null;
      localStorage.removeItem('proxy-manager-token');
      if (typeof message === 'string') this.notify(message, 'error');
    },
    async loadProxies() {
      this.listLoading = true;
      try {
        this.proxies = await this.request('/api/proxies');
      } catch (error) {
        if (this.token) this.notify(error.message, 'error');
      } finally {
        this.listLoading = false;
      }
    },
    async loadVersion() {
      this.versionLoading = true;
      try {
        this.versionInfo = await this.request('/api/version');
      } catch (error) {
        if (this.token) {
          this.versionInfo = {
            currentVersion: this.versionInfo?.currentVersion || null,
            latestVersion: null,
            updateAvailable: false,
            status: 'error'
          };
        }
      } finally {
        this.versionLoading = false;
      }
    },
    openUpdateConfirm() {
      if (!this.versionInfo?.updateAvailable || this.updateLoading) return;
      this.updateConfirmOpen = true;
    },
    closeUpdateConfirm() {
      if (this.updateLoading) return;
      this.updateConfirmOpen = false;
    },
    async startPanelUpdate() {
      this.updateLoading = true;
      try {
        const result = await this.request('/api/update', { method: 'POST' });
        this.updateConfirmOpen = false;
        if (result.status === 'current') {
          await this.loadVersion();
          this.notify('当前已是最新版本', 'success');
          return;
        }
        this.updateTargetVersion = result.targetVersion;
        this.updateOldVersion = this.versionInfo?.currentVersion;
        this.updatePollStartedAt = Date.now();
        this.notify(`正在更新到 v${result.targetVersion}，服务将短暂重启`, 'info');
        this.scheduleUpdatePoll();
      } catch (error) {
        this.notify(error.message, 'error');
      } finally {
        this.updateLoading = false;
      }
    },
    scheduleUpdatePoll() {
      this.stopUpdatePolling();
      this.updatePollTimer = window.setTimeout(() => this.pollUpdateVersion(), 2000);
    },
    stopUpdatePolling() {
      if (this.updatePollTimer) {
        window.clearTimeout(this.updatePollTimer);
        this.updatePollTimer = null;
      }
    },
    async pollUpdateVersion() {
      const targetVersion = this.updateTargetVersion;
      if (!targetVersion || !this.token) return;
      if (Date.now() - this.updatePollStartedAt > 120000) {
        this.stopUpdatePolling();
        this.updateTargetVersion = null;
        this.updateOldVersion = null;
        this.notify('更新等待超时，请稍后重新检查版本', 'error');
        return;
      }

      try {
        const response = await fetch('/api/version', {
          headers: { Authorization: `Bearer ${this.token}` },
          cache: 'no-store'
        });
        if (response.ok) {
          const version = await response.json();
          this.versionInfo = version;
          if (version.currentVersion && version.currentVersion !== this.updateOldVersion) {
            this.stopUpdatePolling();
            this.updateTargetVersion = null;
            this.updateOldVersion = null;
            this.notify(`已更新到 v${version.currentVersion}`, 'success');
            return;
          }
        }
      } catch (error) {
        // The service is temporarily unavailable while systemd restarts it.
      }
      this.scheduleUpdatePoll();
    },
    openAddModal() {
      this.addModalOpen = true;
      this.$nextTick(() => this.$refs.proxyInput?.focus());
    },
    closeAddModal() {
      if (this.addLoading) return;
      this.addModalOpen = false;
      this.form.input = '';
    },
    async addProxy() {
      this.addLoading = true;
      try {
        const proxy = await this.request('/api/proxies', { method: 'POST', body: JSON.stringify({ input: this.form.input }) });
        this.proxies.unshift(proxy);
        this.form.input = '';
        this.addModalOpen = false;
        this.notify(`节点已添加，本地端口为 ${proxy.local_port}`, 'success');
      } catch (error) {
        this.notify(error.message, 'error');
      } finally {
        this.addLoading = false;
      }
    },
    busy(id) {
      return Boolean(this.testing[id] || this.toggling[id] || this.savingName[id] || (this.deleteLoading && this.deleteTarget?.id === id));
    },
    startEditName(proxy) {
      this.editingName = proxy.id;
      this.nameDraft = proxy.name;
      this.$nextTick(() => document.querySelector('.name-edit-form input')?.focus());
    },
    cancelEditName() {
      this.editingName = null;
      this.nameDraft = '';
    },
    async saveName(proxy) {
      const name = this.nameDraft.trim();
      if (!name || name === proxy.name) {
        this.cancelEditName();
        return;
      }
      this.savingName = { ...this.savingName, [proxy.id]: true };
      try {
        const updated = await this.request(`/api/proxies/${proxy.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name })
        });
        this.proxies = this.proxies.map((item) => item.id === proxy.id ? updated : item);
        this.cancelEditName();
        this.notify('节点名称已更新', 'success');
      } catch (error) {
        this.notify(error.message, 'error');
      } finally {
        this.savingName = { ...this.savingName, [proxy.id]: false };
      }
    },
    async testProxy(proxy) {
      this.testing = { ...this.testing, [proxy.id]: true };
      try {
        const result = await this.request('/api/test-proxy', { method: 'POST', body: JSON.stringify({ id: proxy.id }) });
        this.results = { ...this.results, [proxy.id]: result };
        this.notify(`${proxy.name} 测速成功`, 'success');
      } catch (error) {
        this.notify(`${proxy.name}: ${error.message}`, 'error');
      } finally {
        this.testing = { ...this.testing, [proxy.id]: false };
      }
    },
    async toggleProxy(proxy) {
      this.toggling = { ...this.toggling, [proxy.id]: true };
      try {
        const updated = await this.request('/api/toggle-port', { method: 'POST', body: JSON.stringify({ id: proxy.id }) });
        this.proxies = this.proxies.map((item) => item.id === proxy.id ? updated : item);
        this.notify(`${proxy.name} 已${updated.is_running ? '启动' : '停止'}`, 'success');
      } catch (error) {
        this.notify(`${proxy.name}: ${error.message}`, 'error');
      } finally {
        this.toggling = { ...this.toggling, [proxy.id]: false };
      }
    },
    askDelete(proxy) {
      this.deleteTarget = proxy;
    },
    async deleteProxy() {
      if (!this.deleteTarget) return;
      const target = this.deleteTarget;
      this.deleteLoading = true;
      try {
        await this.request(`/api/proxies/${target.id}`, { method: 'DELETE' });
        this.proxies = this.proxies.filter((proxy) => proxy.id !== target.id);
        this.deleteTarget = null;
        this.notify(`${target.name} 已删除`, 'success');
      } catch (error) {
        this.notify(error.message, 'error');
      } finally {
        this.deleteLoading = false;
      }
    },
    notify(message, type = 'info') {
      const id = `${Date.now()}-${Math.random()}`;
      this.notices.push({ id, message, type });
      window.setTimeout(() => { this.notices = this.notices.filter((notice) => notice.id !== id); }, 3600);
    }
  }
}).mount('#app');
