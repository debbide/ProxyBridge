const { createApp } = Vue;

createApp({
  data() {
    return {
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
