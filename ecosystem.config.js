module.exports = {
  "apps": [
    {
      "name": "cortextos-daemon",
      "script": "/Users/cortextos/cortextos-v2/dist/daemon.js",
      "args": "--instance lifeos2",
      "cwd": "/Users/cortextos/cortextos-v2",
      "env": {
        "CTX_INSTANCE_ID": "lifeos2",
        "CTX_ROOT": "/Users/cortextos/.cortextos/lifeos2",
        "CTX_FRAMEWORK_ROOT": "/Users/cortextos/cortextos-v2",
        "CTX_PROJECT_ROOT": "/Users/cortextos/cortextos-v2",
        "CTX_ORG": "lifeos2"
      },
      "max_restarts": 10,
      "restart_delay": 5000,
      "autorestart": true
    }
  ]
};
