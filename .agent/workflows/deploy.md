---
description: Pull latest changes and restart the bot on the Oracle Cloud VPS
---

To deploy the latest changes to the server:

// turbo
1. Run the following command:
   `ssh -i C:\Users\user\arm-key.key ubuntu@80.225.227.0 "source ~/.nvm/nvm.sh && cd ~/doto-tracker && git pull origin ts_cope && npx tsc && sudo systemctl restart doto-tracker"`
