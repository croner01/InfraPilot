import * as k8s from '@kubernetes/client-node';
const kc = new k8s.KubeConfig();
kc.loadFromDefault();
console.log('clusters:', kc.clusters.length);
console.log('users:', kc.users.length);
console.log('contexts:', kc.contexts.length);
console.log('currentContext:', kc.currentContext);
const cluster = kc.getCurrentCluster();
const user = kc.getCurrentUser();
console.log('cluster server:', cluster?.server);
console.log('cluster skipTLSVerify:', cluster?.skipTLSVerify);
console.log('user has cert:', !!user?.certData);
console.log('user has key:', !!user?.keyData);
console.log('user has token:', !!user?.token);
const coreApi = kc.makeApiClient(k8s.CoreV1Api);
try {
  const res = await coreApi.listNamespacedPod({ namespace: 'order-service' });
  console.log('success, pods:', res.items.length);
} catch (e) {
  console.error('error:', e.statusCode, e.message);
  console.error('body:', e.body);
}
