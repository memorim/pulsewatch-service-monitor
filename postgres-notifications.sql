CREATE FUNCTION enqueue_incident_notification() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE event_name TEXT; event_time TEXT;
BEGIN
 IF TG_OP='INSERT' AND NEW.status!='resolved' THEN
   event_name := 'opened'; event_time := NEW.started_at;
 ELSIF TG_OP='UPDATE' AND OLD.status!='resolved' AND NEW.status='resolved' THEN
   event_name := 'closed'; event_time := NEW.resolved_at;
 ELSE RETURN NEW;
 END IF;
 INSERT INTO pulsewatch.notification_outbox(event_key,payload,created_at)
 VALUES('incident:'||NEW.id||':'||event_name,
   json_build_object('event','incident.'||event_name,'incidentId',NEW.id,
     'monitorId',NEW.monitor_id,'title',NEW.title,'severity',NEW.severity,'at',event_time)::text,
   event_time)
 ON CONFLICT(event_key) DO NOTHING;
 RETURN NEW;
END;
$$;
CREATE TRIGGER incident_open_notification AFTER INSERT ON incidents
 FOR EACH ROW EXECUTE FUNCTION enqueue_incident_notification();
CREATE TRIGGER incident_close_notification AFTER UPDATE OF status ON incidents
 FOR EACH ROW EXECUTE FUNCTION enqueue_incident_notification();
