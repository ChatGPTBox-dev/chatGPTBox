export function isEdge() {
  if (navigator.userAgent == null) { // Check for null or undefined
    return false;
  }
  return navigator.userAgent.toLowerCase().includes('edg');
}
