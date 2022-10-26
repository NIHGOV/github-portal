
module.exports = {
  "apps" : [{
    "name"        : "portal",
    "script"      : "./opensource-management-portal/dist/bin/www.js",
  },{
    "name"       : "cache-builder",
    "script"     : "./opensource-management-portal/dist/jobs/refreshQueryCache/index.js",
    "autorestart": "false"
  }]
}
