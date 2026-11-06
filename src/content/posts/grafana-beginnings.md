---
title: Grafana Beginnings
slug: grafana-beginnings
date: 2020-05-02
mins: 5
summary: After recently loosing a drive in my RAID array I decided it's probably a good idea to monitor my server.
sections: ["personal"]
---

After recently loosing a drive in my RAID array I decided it's probably a good idea to monitor my server, my old server was a little HP ProLiant MicroServer Gen8 that was dual core and had 4gb (until I upgraded it to 8) and used to have an ELK stack running for log parsing and monitoring but it used way too much ram so had to be shutdown.

My new server is a lot more powerful and is an enterprise Dell R610 so there's room for a monitoring container or 5!

## Hello InfluxDB

InfluxDB is a database built for time series so it's perfect for time based data.

It also has a powerful query language with useful functions, Grafana provides a nice UI for building out the queries which I've only had to not use once to build a custom query.

Elasticsearch is very powerful and can also be used with Grafana but I decided against it due to resource issues still and it's not worth it for my medium sized server.

## Telegraf

The ELK stack used Logstash to provide parsed data from logs to Elasticsearch which is what the L in ELK is.

Telegraf is similar to the their Metricbeat "plugin", it defines a bunch of inputs, outputs and processors in between. It has support for a lot of inputs by default, I haven't looked in to it yet but it looks simple enough to make a plugin using Go.

By default it sends host information over to InfluxDB such as cpu, ram, disk usage, kernel information etc. Personally I enabled the "docker", "filecount", "ipmi_sensor", "snmp", "snmp_trap", "net", "netstat" and "vsphere" inputs.

More to come on those inputs later.

## Conclusion

I'm still playing around with Grafana and understanding everything it has to offer, I want to get more stats in to it from apps that are not supported in Telegraf but it's working well so far.
