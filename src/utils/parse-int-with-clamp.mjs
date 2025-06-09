export function parseIntWithClamp(value, min, max, defaultValue) {
  value = parseInt(value, 10)

  if (isNaN(value)) value = defaultValue
  else if (value > max) value = max
  else if (value < min) value = min

  return value
}
