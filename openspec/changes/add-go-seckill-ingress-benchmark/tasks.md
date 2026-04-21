1. Add `go-seckill-ingress` service skeleton and Docker image
2. Implement seckill-only `POST /api/buy-intents`
3. Mirror seckill SKU lookup, TTL cache, bucket selection, and Kafka publish
4. Propagate trace headers from HTTP ingress to Kafka
5. Add compose wiring and host port for benchmark access
6. Extend benchmark runner to separate ingress URLs from control app URLs
7. Add benchmark tags for `impl` and `path`
8. Validate end-to-end:
   - `202` accepted
   - `command_status` reaches `created/failed`
   - trace spans cross `go-seckill-ingress -> worker-seckill -> worker-seckill-result-sink`
9. Run the first Next.js vs Go benchmark comparison
